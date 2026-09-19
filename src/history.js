import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { configDir } from './identity.js'

const HISTORY_DIR = 'history'
const VERSION = 1
const MAX_PER_ROOM = 1500
const ALGO = 'aes-256-gcm'

/**
 * Local encrypted chat history (at rest).
 * Key is derived from identity.seed — never leaves the machine, no passphrase UX.
 * This is NOT a server log: only what this client observed while running (plus prior sessions).
 */
export class HistoryStore {
  constructor(seed, { maxPerRoom = MAX_PER_ROOM } = {}) {
    if (!seed || seed.byteLength !== 32) {
      throw new Error('HistoryStore needs a 32-byte identity seed')
    }
    this.key = deriveHistoryKey(seed)
    this.maxPerRoom = maxPerRoom
    this.dir = path.join(configDir(), HISTORY_DIR)
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  roomPath(roomId) {
    const safe = String(roomId).replace(/[^a-z0-9_-]/gi, '_')
    return path.join(this.dir, `${safe}.bin`)
  }

  /** Load structured messages for a room (oldest → newest). */
  load(roomId) {
    const file = this.roomPath(roomId)
    if (!fs.existsSync(file)) return []
    try {
      const raw = fs.readFileSync(file)
      const plain = decrypt(this.key, raw)
      const data = JSON.parse(plain.toString('utf8'))
      if (!data || data.v !== VERSION || !Array.isArray(data.messages)) return []
      return data.messages.slice(-this.maxPerRoom)
    } catch {
      // Corrupt / wrong key / truncated — start fresh rather than crash the TUI.
      return []
    }
  }

  /** Replace room history with the given message list (already capped by caller ideally). */
  save(roomId, messages) {
    const list = Array.isArray(messages) ? messages.slice(-this.maxPerRoom) : []
    const payload = Buffer.from(JSON.stringify({
      v: VERSION,
      room: roomId,
      savedAt: Date.now(),
      messages: list
    }), 'utf8')
    const enc = encrypt(this.key, payload)
    const file = this.roomPath(roomId)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, enc, { mode: 0o600 })
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // ignore
    }
  }

  /** Append one chat (or keep existing id). Returns the updated list. */
  append(roomId, entry) {
    const list = this.load(roomId)
    if (entry?.id && list.some((m) => m.id === entry.id)) return list
    list.push(sanitizeEntry(entry))
    while (list.length > this.maxPerRoom) list.shift()
    this.save(roomId, list)
    return list
  }
}

export function deriveHistoryKey(seed) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    seed,
    Buffer.alloc(0),
    Buffer.from('omachat-history-v1'),
    32
  ))
}

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decrypt(key, blob) {
  if (!blob || blob.byteLength < 12 + 16) throw new Error('history blob too short')
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ciphertext = blob.subarray(28)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function sanitizeEntry(entry) {
  return {
    id: String(entry.id || ''),
    type: entry.type === 'system' ? 'system' : 'chat',
    ts: Number(entry.ts) || Date.now(),
    nick: String(entry.nick || '').slice(0, 32),
    pk: entry.pk ? String(entry.pk).slice(0, 128) : undefined,
    body: String(entry.body || entry.text || '').slice(0, 2000),
    local: Boolean(entry.local)
  }
}
