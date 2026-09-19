import { EventEmitter } from 'node:events'
import { Room } from './room.js'
import { HistoryStore } from './history.js'
import { normalizeRoom, ROOMS, DEFAULT_ROOM } from './topic.js'

const DEFAULT_SUBSCRIBE = Object.keys(ROOMS)

/**
 * Keeps multiple rooms joined while the client is online.
 * UI focuses one room at a time without tearing down the others —
 * so #help traffic is captured while you sit in #lobby.
 */
export class Session extends EventEmitter {
  constructor({ identity, history, subscribe = DEFAULT_SUBSCRIBE } = {}) {
    super()
    this.identity = identity
    this.history = history || new HistoryStore(identity.seed)
    this.focusId = DEFAULT_ROOM
    /** @type {Map<string, RoomSlot>} */
    this.slots = new Map()
    this.subscribeList = subscribe.map(normalizeRoom)
    this.started = false
    this._directDiscoveryAssigned = false
  }

  get focus() {
    return this.slots.get(this.focusId) || null
  }

  get room() {
    return this.focus?.room || null
  }

  roomIds() {
    const ids = [...this.slots.keys()]
    ids.sort((a, b) => {
      const ia = DEFAULT_SUBSCRIBE.indexOf(a)
      const ib = DEFAULT_SUBSCRIBE.indexOf(b)
      if (ia >= 0 && ib >= 0) return ia - ib
      if (ia >= 0) return -1
      if (ib >= 0) return 1
      return a.localeCompare(b)
    })
    return ids
  }

  unread(roomId) {
    return this.slots.get(normalizeRoom(roomId))?.unread || 0
  }

  lines(roomId = this.focusId) {
    return this.slots.get(normalizeRoom(roomId))?.lines || []
  }

  async start(initialRoom = DEFAULT_ROOM) {
    if (this.started) return
    this.started = true
    this.focusId = normalizeRoom(initialRoom)

    await this.ensureRoom(this.focusId)
    const slot = this.slots.get(this.focusId)
    if (slot) slot.unread = 0
    this.emit('focus', { roomId: this.focusId })

    // Stay subscribed to the other defaults without blocking first paint.
    for (const id of this.subscribeList) {
      if (id === this.focusId) continue
      this.ensureRoom(id).catch((err) => this.emit('error', err))
    }
  }

  async ensureRoom(roomId) {
    const id = normalizeRoom(roomId)
    if (this.slots.has(id)) return this.slots.get(id)

    const enableDirect = !this._directDiscoveryAssigned
    if (enableDirect) this._directDiscoveryAssigned = true

    const room = new Room({
      identity: this.identity,
      roomId: id,
      enableMdns: enableDirect && process.env.OMACHAT_NO_MDNS !== '1',
      enableTailscale: enableDirect && process.env.OMACHAT_NO_TAILSCALE !== '1'
    })

    const slot = {
      id,
      room,
      lines: [],
      unread: 0,
      persisted: this.history.load(id),
      seenIds: new Set()
    }

    for (const entry of slot.persisted) {
      slot.seenIds.add(entry.id)
      slot.lines.push(formatStored(entry, this.identity.publicKeyHex))
    }
    trimLines(slot)

    this.#wire(slot)
    this.slots.set(id, slot)
    await room.join()
    this.emit('room', { event: 'up', roomId: id })
    return slot
  }

  async focusRoom(roomId) {
    const id = normalizeRoom(roomId)
    await this.ensureRoom(id)
    if (this.focusId === id) return this.slots.get(id)
    this.focusId = id
    const slot = this.slots.get(id)
    slot.unread = 0
    this.emit('focus', { roomId: id })
    return slot
  }

  say(text) {
    const slot = this.focus
    if (!slot) return null
    return slot.room.say(text)
  }

  announceNick(oldNick) {
    for (const slot of this.slots.values()) {
      try {
        slot.room.announceNick(oldNick)
      } catch {
        // ignore
      }
    }
  }

  pushSystem(text, at = Date.now(), roomId = this.focusId) {
    const slot = this.slots.get(normalizeRoom(roomId))
    if (!slot) return
    slot.lines.push(formatSystem(text, at))
    trimLines(slot)
    this.emit('lines', { roomId: slot.id })
  }

  async stop() {
    const rooms = [...this.slots.values()]
    this.slots.clear()
    this.started = false
    this._directDiscoveryAssigned = false
    await Promise.all(rooms.map(async (slot) => {
      try {
        await slot.room.leave()
      } catch {
        // ignore
      }
    }))
  }

  #wire(slot) {
    const { room, id } = slot

    room.on('joined', ({ port }) => {
      this.pushSystem(`listening · tcp :${port} · hyperswarm announced`, Date.now(), id)
    })

    const lastDisco = new Map()
    room.on('discovery', (s) => {
      if (!s?.layer) return
      const key = `${s.ok}:${s.detail || ''}`
      if (lastDisco.get(s.layer) === key) return
      lastDisco.set(s.layer, key)
      if (s.ok) this.pushSystem(`${s.layer}: ${s.detail}`, Date.now(), id)
      else this.emit('lines', { roomId: id })
    })

    room.on('peer', () => this.emit('peer', { roomId: id }))

    room.on('presence', (msg) => {
      if (msg.pk === this.identity.publicKeyHex) return
      const via = msg.via ? ` via ${msg.via}` : ''
      this.pushSystem(`${msg.nick} is here${via}`, msg.ts, id)
    })

    room.on('system', (msg) => {
      this.pushSystem(msg.text, msg.ts, id)
    })

    room.on('chat', (msg) => {
      this.#onChat(slot, msg)
    })
  }

  #onChat(slot, msg) {
    if (msg.id && slot.seenIds.has(msg.id)) return
    if (msg.id) slot.seenIds.add(msg.id)

    const entry = {
      id: msg.id,
      type: 'chat',
      ts: msg.ts || Date.now(),
      nick: msg.nick,
      pk: msg.pk,
      body: msg.body,
      local: Boolean(msg.local)
    }

    slot.persisted = this.history.append(slot.id, entry)
    slot.lines.push(formatStored(entry, this.identity.publicKeyHex))
    trimLines(slot)

    const focused = slot.id === this.focusId
    if (!focused) {
      slot.unread += 1
      this.emit('unread', { roomId: slot.id, count: slot.unread, msg: entry })
    }

    this.emit('chat', { roomId: slot.id, msg: entry, focused })
    this.emit('lines', { roomId: slot.id })
  }
}

function trimLines(slot, max = 1500) {
  if (slot.lines.length > max) slot.lines.splice(0, slot.lines.length - (max - 200))
  if (slot.seenIds.size > max * 2) {
    slot.seenIds = new Set(slot.persisted.map((m) => m.id).filter(Boolean))
  }
}

function formatStored(entry, myPk) {
  if (entry.type === 'system') return formatSystem(entry.body, entry.ts)
  const when = tsShort(entry.ts)
  const nick = clampStr(entry.nick || '?', 12)
  const mine = entry.local || entry.pk === myPk
  const GREEN = '\x1b[32m'
  const CYAN = '\x1b[36m'
  const GRAY = '\x1b[90m'
  const RESET = '\x1b[0m'
  const nickColored = mine ? `${GREEN}${nick}${RESET}` : `${CYAN}${nick}${RESET}`
  return `${GRAY}${when}${RESET} ${nickColored} ${entry.body || ''}`
}

function formatSystem(text, at = Date.now()) {
  const GRAY = '\x1b[90m'
  const RESET = '\x1b[0m'
  const when = tsShort(at)
  const nick = clampStr('*', 12)
  return `${GRAY}${when} ${nick} ${text}${RESET}`
}

function tsShort(ms = Date.now()) {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

function clampStr(s, n) {
  const str = String(s)
  if (str.length <= n) return str.padEnd(n)
  return str.slice(0, Math.max(0, n - 1)) + '...'
}

/**
 * @typedef {object} RoomSlot
 * @property {string} id
 * @property {import('./room.js').Room} room
 * @property {string[]} lines
 * @property {number} unread
 * @property {object[]} persisted
 * @property {Set<string>} seenIds
 */
