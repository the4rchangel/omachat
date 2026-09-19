import { EventEmitter } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { connectDirect } from '../net/direct.js'

const SERVICE_TYPE = '_omachat._tcp'

/**
 * LAN discovery via Avahi (mDNS/DNS-SD).
 * Publishes pk+room+nick; browses and opens direct TCP to matching rooms.
 */
export class MdnsDiscovery extends EventEmitter {
  constructor({ roomId, identity, port, onSocket, joinPeer }) {
    super()
    this.roomId = roomId
    this.identity = identity
    this.port = port
    this.onSocket = onSocket
    this.joinPeer = joinPeer
    this.publishProc = null
    this.browseProc = null
    this.seen = new Set()
    this.stopped = false
  }

  start() {
    if (!which('avahi-publish') || !which('avahi-browse')) {
      this.emit('status', { layer: 'mdns', ok: false, detail: 'avahi tools missing' })
      return
    }
    this.#publish()
    this.#browse()
    this.emit('status', { layer: 'mdns', ok: true, detail: `publishing :${this.port}` })
  }

  #publish() {
    const name = `omachat-${this.identity.nick}-${this.identity.publicKeyHex.slice(0, 8)}`
    const txt = [
      'v=1',
      `room=${this.roomId}`,
      `pk=${this.identity.publicKeyHex}`,
      `nick=${this.identity.nick}`
    ]
    this.publishProc = spawn(
      'avahi-publish',
      ['-s', name, SERVICE_TYPE, String(this.port), ...txt],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    this.publishProc.on('error', () => {
      this.emit('status', { layer: 'mdns', ok: false, detail: 'avahi-publish failed' })
    })
    this.publishProc.stderr?.on('data', (buf) => {
      const s = buf.toString()
      if (/Failed|Error/i.test(s)) {
        this.emit('status', { layer: 'mdns', ok: false, detail: s.trim().slice(0, 80) })
      }
    })
  }

  #browse() {
    this.browseProc = spawn(
      'avahi-browse',
      ['-rptk', SERVICE_TYPE],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.browseProc.on('error', () => {
      this.emit('status', { layer: 'mdns', ok: false, detail: 'avahi-browse failed' })
    })

    let pending = ''
    this.browseProc.stdout.on('data', (buf) => {
      pending += buf.toString()
      const lines = pending.split('\n')
      pending = lines.pop() || ''
      for (const line of lines) this.#onBrowseLine(line)
    })
  }

  async #onBrowseLine(line) {
    if (this.stopped || !line.startsWith('=')) return
    const parts = line.split(';')
    // =;iface;proto;name;type;domain;host;address;port;txt...
    if (parts.length < 10) return
    const address = parts[7]
    const port = Number(parts[8])
    const txt = parseTxt(parts.slice(9).join(';'))
    if (txt.room !== this.roomId) return
    if (!txt.pk || txt.pk === this.identity.publicKeyHex) return
    if (!address || !Number.isFinite(port)) return

    const key = `${address}:${port}:${txt.pk}`
    if (this.seen.has(key)) return
    this.seen.add(key)

    if (this.joinPeer && /^[0-9a-f]{64}$/i.test(txt.pk)) {
      try {
        this.joinPeer(Buffer.from(txt.pk, 'hex'))
      } catch {
        // ignore
      }
    }

    this.emit('found', { via: 'mdns', address, port, pk: txt.pk, nick: txt.nick })
    const socket = await connectDirect(address, port, { via: 'mdns', timeoutMs: 1000 })
    if (socket && !this.stopped) {
      this.onSocket(socket, { via: 'mdns', pk: txt.pk, nick: txt.nick })
    }
  }

  stop() {
    this.stopped = true
    for (const proc of [this.publishProc, this.browseProc]) {
      if (!proc || proc.killed) continue
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    this.publishProc = null
    this.browseProc = null
  }
}

function parseTxt(raw) {
  const out = {}
  const matches = raw.matchAll(/"([^"]+)"/g)
  for (const m of matches) {
    const bit = m[1]
    const eq = bit.indexOf('=')
    if (eq === -1) continue
    out[bit.slice(0, eq)] = bit.slice(eq + 1)
  }
  if (!Object.keys(out).length) {
    for (const bit of raw.split(/\s+/)) {
      const eq = bit.indexOf('=')
      if (eq === -1) continue
      out[bit.slice(0, eq).replace(/^"/, '')] = bit.slice(eq + 1).replace(/"$/, '')
    }
  }
  return out
}

function which(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${shellQuote(bin)}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}
