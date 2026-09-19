import net from 'node:net'
import { EventEmitter } from 'node:events'
import { socketPath, writeLine, lineReader } from './ipc.js'
import { normalizeRoom, DEFAULT_ROOM } from './topic.js'

/**
 * Session-shaped client that talks to omachat-daemon over a Unix socket.
 * Keeps a local mirror of lines/unread so the TUI can render the same way.
 */
export class RemoteSession extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.focusId = DEFAULT_ROOM
    this.identity = { nick: null, publicKeyHex: null }
    this._rooms = new Map() // id -> { unread, peers, nicks, disco, lines }
    this._reqId = 0
    this._pending = new Map()
    this.started = false
  }

  get room() {
    const id = this.focusId
    const snap = this._rooms.get(id)
    if (!snap) return null
    return {
      peerCount: snap.peers,
      peerNicks: () => snap.nicks || [],
      discoveryStatus: () => snap.disco || {}
    }
  }

  get slots() {
    // Minimal Map-like for tui checks
    return {
      has: (id) => this._rooms.has(normalizeRoom(id))
    }
  }

  roomIds() {
    return [...this._rooms.keys()]
  }

  unread(roomId) {
    return this._rooms.get(normalizeRoom(roomId))?.unread || 0
  }

  lines(roomId = this.focusId) {
    return this._rooms.get(normalizeRoom(roomId))?.lines || []
  }

  static async tryConnect({ timeoutMs = 400 } = {}) {
    const path = socketPath()
    return new Promise((resolve) => {
      const socket = net.createConnection(path)
      let settled = false
      const done = (client) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(client)
      }
      const timer = setTimeout(() => {
        socket.destroy()
        done(null)
      }, timeoutMs)
      socket.once('connect', () => {
        const remote = new RemoteSession()
        remote.#bind(socket)
        done(remote)
      })
      socket.once('error', () => done(null))
    })
  }

  #bind(socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', lineReader((msg) => this.#onMessage(msg)))
    socket.on('close', () => {
      this.started = false
      this.emit('disconnected')
    })
    socket.on('error', () => {})
  }

  #onMessage(msg) {
    if (msg && msg.event) {
      this.#onEvent(msg)
      return
    }
    if (msg && msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error || 'request failed'))
    }
  }

  #onEvent(msg) {
    switch (msg.event) {
      case 'lines': {
        const slot = this.#ensure(msg.roomId)
        if (Array.isArray(msg.lines)) slot.lines = msg.lines
        this.emit('lines', { roomId: msg.roomId })
        break
      }
      case 'peer': {
        // refresh via status lazily — bump redraw
        this.emit('peer', { roomId: msg.roomId })
        this.request('status').then((s) => this.#applySnapshot(s)).catch(() => {})
        break
      }
      case 'unread': {
        const slot = this.#ensure(msg.roomId)
        slot.unread = msg.count || 0
        this.emit('unread', { roomId: msg.roomId, count: slot.unread })
        break
      }
      case 'focus':
        this.focusId = msg.roomId
        this.emit('focus', { roomId: msg.roomId })
        break
      case 'chat':
        this.emit('chat', { roomId: msg.roomId, focused: msg.focused, msg: msg.msg })
        break
      default:
        break
    }
  }

  #ensure(roomId) {
    const id = normalizeRoom(roomId)
    if (!this._rooms.has(id)) {
      this._rooms.set(id, { unread: 0, peers: 0, nicks: [], disco: {}, lines: [] })
    }
    return this._rooms.get(id)
  }

  #applySnapshot(snap) {
    if (!snap) return
    this.focusId = snap.focusId || this.focusId
    this.identity.nick = snap.nick
    this.identity.publicKeyHex = snap.pk
    this._rooms.clear()
    for (const id of snap.roomIds || Object.keys(snap.rooms || {})) {
      const r = snap.rooms?.[id] || {}
      this._rooms.set(id, {
        unread: r.unread || 0,
        peers: r.peers || 0,
        nicks: r.nicks || [],
        disco: r.disco || {},
        lines: r.lines || []
      })
    }
  }

  request(cmd, fields = {}) {
    const id = ++this._reqId
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('not connected to omachat-daemon'))
        return
      }
      this._pending.set(id, { resolve, reject })
      writeLine(this.socket, { id, cmd, ...fields })
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error(`timeout: ${cmd}`))
        }
      }, 15000)
    })
  }

  async start(initialRoom = DEFAULT_ROOM) {
    const snap = await this.request('attach', { room: normalizeRoom(initialRoom) })
    this.#applySnapshot(snap)
    this.started = true
    this.emit('focus', { roomId: this.focusId })
  }

  async focusRoom(roomId) {
    const id = normalizeRoom(roomId)
    await this.request('focus', { room: id })
    this.focusId = id
    const slot = this.#ensure(id)
    slot.unread = 0
    // refresh lines for this room
    const snap = await this.request('status')
    this.#applySnapshot(snap)
    this.emit('focus', { roomId: id })
    return slot
  }

  say(text) {
    this.request('say', { body: text, room: this.focusId }).catch(() => {})
    return { id: 'pending' }
  }

  announceNick(oldNick) {
    // nick change goes through request('nick') from TUI
    void oldNick
  }

  pushSystem(text, at = Date.now(), roomId = this.focusId) {
    this.request('pushSystem', { text, ts: at, room: roomId }).catch(() => {})
  }

  async setNick(nick) {
    const r = await this.request('nick', { nick })
    this.identity.nick = r.nick
    return r.nick
  }

  async stop() {
    // Detach TUI only — leave the daemon running.
    try {
      this.socket?.end()
    } catch {
      // ignore
    }
    this.socket = null
    this.started = false
  }

  async quitDaemon() {
    try {
      await this.request('quit')
    } catch {
      // ignore
    }
    await this.stop()
  }
}
