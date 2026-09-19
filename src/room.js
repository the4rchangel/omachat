import { EventEmitter } from 'node:events'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { roomTopic, normalizeRoom } from './topic.js'
import {
  PROTOCOL,
  encode,
  decodeLines,
  makePresence,
  makeChat,
  makeNick,
  createSeenSet
} from './protocol.js'
import { DirectServer, DEFAULT_PORT } from './net/direct.js'
import { MdnsDiscovery } from './discovery/mdns.js'
import { TailscaleDiscovery } from './discovery/tailscale.js'

/**
 * One chat room with layered discovery:
 *   1. Hyperswarm / HyperDHT (global)
 *   2. mDNS / Avahi (LAN)
 *   3. Tailscale peer probe (tailnet)
 *
 * Direct TCP shares the same JSON-line gossip protocol as Hyperswarm streams.
 */
export class Room extends EventEmitter {
  constructor({ identity, roomId, enableMdns = true, enableTailscale = true }) {
    super()
    this.identity = identity
    this.roomId = normalizeRoom(roomId)
    this.enableMdns = enableMdns
    this.enableTailscale = enableTailscale
    this.swarm = null
    this.direct = null
    this.mdns = null
    this.tailscale = null
    this.peers = new Map() // conn -> { pk, nick, pending, via }
    this.peersByPk = new Map() // pk -> conn
    this.seen = createSeenSet()
    this.joined = false
    this.layers = {
      hyperswarm: { ok: false, detail: 'starting' },
      mdns: { ok: false, detail: enableMdns ? 'starting' : 'disabled' },
      tailscale: { ok: false, detail: enableTailscale ? 'checking...' : 'disabled' }
    }
  }

  get peerCount() {
    return this.peers.size
  }

  get directPort() {
    return this.direct?.port || null
  }

  peerNicks() {
    const nicks = []
    for (const info of this.peers.values()) {
      if (info.nick) nicks.push(info.nick)
    }
    return nicks.sort((a, b) => a.localeCompare(b))
  }

  discoveryStatus() {
    return {
      ...this.layers,
      port: this.directPort,
      peers: this.peerCount
    }
  }

  async join() {
    if (this.joined) return
    const topic = roomTopic(this.roomId)

    this.direct = new DirectServer()
    const port = await this.direct.listen(DEFAULT_PORT)
    this.direct.on('connection', (socket, meta) => this.#onConnection(socket, meta))

    this.swarm = new Hyperswarm({ keyPair: this.identity.keyPair })
    this.swarm.on('connection', (conn, info) => {
      this.#onConnection(conn, { via: 'hyperswarm', topics: info?.topics })
    })

    this.discovery = this.swarm.join(topic, { server: true, client: true })
    await this.swarm.flush()
    this.layers.hyperswarm = { ok: true, detail: 'topic announced' }

    if (this.enableMdns) {
      this.mdns = new MdnsDiscovery({
        roomId: this.roomId,
        identity: this.identity,
        port,
        onSocket: (socket, meta) => this.#onConnection(socket, meta),
        joinPeer: (pk) => {
          try {
            this.swarm.joinPeer(pk)
          } catch {
            // ignore
          }
        }
      })
      this.mdns.on('status', (s) => {
        this.layers.mdns = { ok: s.ok, detail: s.detail }
        this.emit('discovery', s)
      })
      this.mdns.on('found', (f) => this.emit('discovery', { layer: 'mdns', ok: true, detail: `found ${f.nick || f.pk?.slice(0, 8)}` }))
      this.mdns.start()
    }

    if (this.enableTailscale) {
      this.tailscale = new TailscaleDiscovery({
        roomId: this.roomId,
        identity: this.identity,
        port,
        onSocket: (socket, meta) => this.#onConnection(socket, meta)
      })
      this.tailscale.on('status', (s) => {
        this.layers.tailscale = { ok: s.ok, detail: s.detail }
        this.emit('discovery', s)
      })
      this.tailscale.on('found', (f) => {
        this.emit('discovery', { layer: 'tailscale', ok: true, detail: `probe ${f.label || f.address}` })
      })
      this.tailscale.start()
    }

    this.joined = true
    this.emit('joined', {
      room: this.roomId,
      topic: b4a.toString(topic, 'hex'),
      port,
      layers: this.discoveryStatus()
    })
  }

  #onConnection(conn, meta = {}) {
    if (conn._omachatBound) return
    conn._omachatBound = true

    const via = meta.via || 'direct'
    const state = {
      pk: meta.pk || null,
      nick: meta.nick || null,
      pending: b4a.alloc(0),
      via,
      authed: via === 'hyperswarm'
    }
    this.peers.set(conn, state)
    this.emit('peer', { event: 'up', count: this.peerCount, via })

    try {
      conn.write(encode(makePresence({
        nick: this.identity.nick,
        room: this.roomId,
        pk: this.identity.publicKeyHex
      })))
    } catch {
      this.#drop(conn)
      return
    }

    // Direct / probe paths must prove they speak omachat for this room.
    if (!state.authed) {
      state.handshakeTimer = setTimeout(() => {
        if (!state.authed) this.#drop(conn)
      }, 2500)
      state.handshakeTimer.unref?.()
    }

    conn.on('data', (buf) => {
      const { messages, rest } = decodeLines(buf, state.pending)
      state.pending = rest
      for (const msg of messages) this.#handle(conn, state, msg)
    })

    const gone = () => this.#drop(conn)
    conn.once('close', gone)
    conn.on('error', () => {
      try {
        conn.destroy?.()
      } catch {
        // ignore
      }
    })
  }

  #drop(conn) {
    if (!this.peers.has(conn)) return
    const left = this.peers.get(conn)
    if (left?.handshakeTimer) clearTimeout(left.handshakeTimer)
    this.peers.delete(conn)
    if (left?.pk && this.peersByPk.get(left.pk) === conn) {
      this.peersByPk.delete(left.pk)
    }
    try {
      conn.destroy?.()
    } catch {
      // ignore
    }
    this.emit('peer', {
      event: 'down',
      count: this.peerCount,
      nick: left?.nick,
      via: left?.via
    })
  }

  #handle(conn, state, msg) {
    if (msg.room && normalizeRoom(msg.room) !== this.roomId) {
      // Direct probes from other rooms - hang up.
      if (state.via === 'mdns' || state.via === 'tailscale' || state.via === 'direct') {
        this.#drop(conn)
      }
      return
    }
    if (!msg.id || !this.seen.add(msg.id)) return

    if (msg.pk) {
      if (msg.pk === this.identity.publicKeyHex) return
      const existing = this.peersByPk.get(msg.pk)
      if (existing && existing !== conn) {
        // Already talking to this identity on another path - drop duplicate.
        this.#drop(conn)
        return
      }
      state.pk = msg.pk
      this.peersByPk.set(msg.pk, conn)
    }
    if (msg.nick) state.nick = msg.nick

    if (msg.type === 'presence') {
      state.authed = true
      if (state.handshakeTimer) {
        clearTimeout(state.handshakeTimer)
        state.handshakeTimer = null
      }
      this.emit('presence', { ...msg, via: state.via })
      this.#gossip(conn, msg)
      return
    }

    if (msg.type === 'nick') {
      this.emit('system', {
        text: `${msg.body || '?'} is now ${msg.nick}`,
        ts: msg.ts
      })
      this.#gossip(conn, msg)
      return
    }

    if (msg.type === 'chat' && msg.body) {
      this.emit('chat', { ...msg, via: state.via })
      this.#gossip(conn, msg)
    }
  }

  #gossip(origin, msg) {
    const wire = encode(msg)
    for (const [conn] of this.peers) {
      if (conn === origin) continue
      try {
        conn.write(wire)
      } catch {
        // peer may have closed mid-write
      }
    }
  }

  #broadcast(msg) {
    this.seen.add(msg.id)
    const wire = encode(msg)
    for (const [conn] of this.peers) {
      try {
        conn.write(wire)
      } catch {
        // ignore
      }
    }
  }

  say(body) {
    const text = String(body || '').trim()
    if (!text) return null
    const msg = makeChat({
      nick: this.identity.nick,
      room: this.roomId,
      pk: this.identity.publicKeyHex,
      body: text
    })
    this.#broadcast(msg)
    this.emit('chat', { ...msg, local: true })
    return msg
  }

  announceNick(oldNick) {
    const msg = makeNick({
      nick: this.identity.nick,
      room: this.roomId,
      pk: this.identity.publicKeyHex,
      body: oldNick || this.identity.nick
    })
    this.#broadcast(msg)
    return msg
  }

  async leave() {
    this.mdns?.stop()
    this.tailscale?.stop()
    this.mdns = null
    this.tailscale = null

    try {
      await this.direct?.close()
    } catch {
      // ignore
    }
    this.direct = null

    if (this.swarm) {
      const swarm = this.swarm
      this.swarm = null
      try {
        await Promise.race([
          swarm.destroy(),
          new Promise((resolve) => setTimeout(resolve, 1500))
        ])
      } catch {
        // ignore
      }
    }

    for (const conn of [...this.peers.keys()]) {
      try {
        conn.destroy?.()
      } catch {
        // ignore
      }
    }
    this.peers.clear()
    this.peersByPk.clear()
    this.joined = false
  }
}

export function protocolBanner() {
  return PROTOCOL
}
