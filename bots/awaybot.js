#!/usr/bin/env node
/**
 * archangel-awaybot — Omachat peer that watches a room and replies via local Ollama.
 *
 * Separate identity/config so it is a real second peer on the swarm (not your nick).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { Room } from '../src/room.js'

const BOT_NICK = process.env.OMACHAT_AWAYBOT_NICK || 'archangel-awaybot'
const OWNER_NICK = (process.env.OMACHAT_AWAYBOT_OWNER || 'archangel').toLowerCase()
const ROOM_ID = process.env.OMACHAT_AWAYBOT_ROOM || 'lobby'
const MODEL = process.env.OMACHAT_AWAYBOT_MODEL || 'mistral-nemo:12b'
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
const PING_MS = Number(process.env.OMACHAT_AWAYBOT_PING_MS || 1000)
const CONFIG =
  process.env.OMACHAT_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omachat-awaybot')

process.env.OMACHAT_CONFIG = CONFIG

function makeIdentity(configDir, nick) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const seedPath = path.join(configDir, 'identity.seed')
  let seed
  if (fs.existsSync(seedPath)) {
    seed = b4a.from(fs.readFileSync(seedPath, 'utf8').trim(), 'hex')
  } else {
    seed = crypto.randomBytes(32)
    fs.writeFileSync(seedPath, b4a.toString(seed, 'hex') + '\n', { mode: 0o600 })
  }
  fs.writeFileSync(path.join(configDir, 'nick'), nick + '\n', { mode: 0o600 })
  const keyPair = crypto.keyPair(seed)
  return {
    nick,
    keyPair,
    publicKeyHex: b4a.toString(keyPair.publicKey, 'hex')
  }
}

async function ollamaReply(incoming) {
  const system = `You are ${BOT_NICK}, a brief away-message bot for Omarchy Omachat.
Archangel is AFK. Someone else on another network/machine just messaged the lobby.
Read their message, then reply in 1-3 short sentences:
1) Start with a friendly hi / greeting
2) Say archangel is away right now
3) Confirm they successfully reached a real peer on an entirely different network (you — a local Ollama/${MODEL} bot), not a dead room
Do not pretend to be archangel. No markdown. Keep under 400 characters.`

  const prompt = `${system}

Their message:
"""
${incoming.body}
"""
(from nick: ${incoming.nick})

Your reply:`

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.6, num_predict: 120 }
    })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`ollama ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = await res.json()
  let text = String(data.response || '').trim().replace(/\s+/g, ' ')
  if (!text) {
    text = `Hi ${incoming.nick} — archangel is away. You're chatting with ${BOT_NICK} on another machine via Ollama (${MODEL}), so the P2P room works.`
  }
  return text.slice(0, 500)
}

function shouldReply(msg) {
  if (!msg?.body || msg.local) return false
  const nick = String(msg.nick || '').toLowerCase()
  if (!nick) return false
  if (nick === BOT_NICK.toLowerCase()) return false
  if (nick === OWNER_NICK) return false
  if (msg.pk && msg.pk === identity.publicKeyHex) return false
  // avoid obvious bot-echo loops
  if (/archangel is away|awaybot|ollama/i.test(msg.body) && /hi\b/i.test(msg.body)) return false
  return true
}

const identity = makeIdentity(CONFIG, BOT_NICK)
/** @type {{msg: object, enqueuedAt: number}[]} */
const queue = []
const recentIds = new Set()
let busy = false
let ticks = 0

const room = new Room({
  identity,
  roomId: ROOM_ID,
  enableMdns: process.env.OMACHAT_NO_MDNS !== '1',
  enableTailscale: process.env.OMACHAT_NO_TAILSCALE !== '1'
})

room.on('peer', (p) => {
  console.log(`[peer] ${p.event} count=${p.count} via=${p.via || '?'}`)
})
room.on('chat', (msg) => {
  if (!shouldReply(msg)) return
  if (msg.id && recentIds.has(msg.id)) return
  if (msg.id) {
    recentIds.add(msg.id)
    if (recentIds.size > 500) {
      const first = recentIds.values().next().value
      recentIds.delete(first)
    }
  }
  console.log(`[inbox] ${msg.nick}: ${msg.body}`)
  queue.push({ msg, enqueuedAt: Date.now() })
})

await room.join()
console.log(`[awaybot] nick=${BOT_NICK} room=#${ROOM_ID} model=${MODEL} ping=${PING_MS}ms`)
console.log(`[awaybot] config=${CONFIG}`)
console.log(`[awaybot] ignoring owner nick=${OWNER_NICK}`)
console.log(`[disco]`, room.discoveryStatus())

async function drainOnce() {
  if (busy || queue.length === 0) return
  busy = true
  const { msg } = queue.shift()
  try {
    const reply = await ollamaReply(msg)
    console.log(`[reply] ${reply}`)
    room.say(reply)
  } catch (err) {
    console.error(`[ollama]`, err.message || err)
    room.say(
      `Hi ${msg.nick} — archangel is away. You're on a live P2P peer (${BOT_NICK}); Ollama errored: ${String(err.message || err).slice(0, 80)}`
    )
  } finally {
    busy = false
  }
}

setInterval(() => {
  ticks += 1
  if (ticks % 30 === 0) {
    console.log(`[ping] peers=${room.peerCount} queue=${queue.length} disco=`, room.discoveryStatus())
  }
  drainOnce().catch((err) => console.error(err))
}, PING_MS)

async function shutdown() {
  console.log('[awaybot] leaving')
  try {
    await room.leave()
  } catch {
    // ignore
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
