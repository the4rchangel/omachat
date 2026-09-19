import crypto from 'node:crypto'
import b4a from 'b4a'

export const PROTOCOL = 'omachat/1'

export function newId() {
  return crypto.randomBytes(12).toString('hex')
}

export function encode(msg) {
  return b4a.from(JSON.stringify(msg) + '\n')
}

/** Split a buffer stream into JSON lines. Returns { messages, rest }. */
export function decodeLines(buf, pending = b4a.alloc(0)) {
  const data = pending.byteLength ? b4a.concat([pending, buf]) : buf
  const text = b4a.toString(data)
  const parts = text.split('\n')
  const rest = b4a.from(parts.pop() || '')
  const messages = []
  for (const line of parts) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const msg = JSON.parse(trimmed)
      if (msg && typeof msg === 'object' && msg.v === 1 && msg.type) {
        messages.push(msg)
      }
    } catch {
      // drop malformed lines
    }
  }
  return { messages, rest }
}

export function makePresence({ nick, room, pk }) {
  return {
    v: 1,
    type: 'presence',
    id: newId(),
    ts: Date.now(),
    nick,
    room,
    pk,
    body: 'join'
  }
}

export function makeChat({ nick, room, pk, body }) {
  return {
    v: 1,
    type: 'chat',
    id: newId(),
    ts: Date.now(),
    nick,
    room,
    pk,
    body: String(body).slice(0, 2000)
  }
}

export function makeNick({ nick, room, pk, body }) {
  return {
    v: 1,
    type: 'nick',
    id: newId(),
    ts: Date.now(),
    nick,
    room,
    pk,
    body: String(body).slice(0, 32)
  }
}

/** Keep recent message ids to stop gossip loops. */
export function createSeenSet(limit = 2000) {
  const seen = new Set()
  const order = []
  return {
    has(id) {
      return seen.has(id)
    },
    add(id) {
      if (seen.has(id)) return false
      seen.add(id)
      order.push(id)
      while (order.length > limit) {
        const old = order.shift()
        seen.delete(old)
      }
      return true
    }
  }
}
