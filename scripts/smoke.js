#!/usr/bin/env node
/** Two in-process peers on a private room — verifies Hyperswarm + gossip. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { Room } from '../src/room.js'

const roomName = 'omachat-smoke-' + Date.now().toString(36)

function makeIdentity(configDir, nick) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const seed = crypto.randomBytes(32)
  fs.writeFileSync(path.join(configDir, 'identity.seed'), b4a.toString(seed, 'hex') + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(configDir, 'nick'), nick + '\n', { mode: 0o600 })
  const keyPair = crypto.keyPair(seed)
  return {
    nick,
    keyPair,
    publicKeyHex: b4a.toString(keyPair.publicKey, 'hex')
  }
}

async function peer(label, configDir, nick, expectBody) {
  const identity = makeIdentity(configDir, nick)
  const room = new Room({
    identity,
    roomId: roomName,
    enableMdns: process.env.OMACHAT_SMOKE_MDNS !== '0',
    enableTailscale: false // avoid probing the whole tailnet in CI/smoke
  })
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timeout waiting for chat')), 60000)
    room.on('chat', (msg) => {
      if (msg.local) return
      if (msg.body === expectBody) {
        clearTimeout(t)
        resolve(msg)
      }
    })
  })
  await room.join()
  console.log(`[${label}] joined ${roomName} port=${room.directPort}`)
  console.log(`[${label}] disco`, room.discoveryStatus())
  return { room, got, label }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omachat-smoke-'))
  const a = await peer('A', path.join(base, 'a'), 'SmokeA', 'pong-from-b')
  const b = await peer('B', path.join(base, 'b'), 'SmokeB', 'ping-from-a')

  for (let i = 0; i < 12; i++) {
    if (a.room.peerCount >= 1 || b.room.peerCount >= 1) break
    await new Promise((r) => setTimeout(r, 2500))
    console.log(`[wait] A=${a.room.peerCount} B=${b.room.peerCount}`)
  }
  console.log(`[ready] A peers=${a.room.peerCount} B peers=${b.room.peerCount}`)

  if (a.room.peerCount < 1 && b.room.peerCount < 1) {
    throw new Error('Peers never connected — check UDP/outbound to HyperDHT bootstraps')
  }

  a.room.say('ping-from-a')
  const fromA = await b.got
  console.log(`[B] got: ${fromA.nick}: ${fromA.body}`)

  b.room.say('pong-from-b')
  const fromB = await a.got
  console.log(`[A] got: ${fromB.nick}: ${fromB.body}`)

  await a.room.leave()
  await b.room.leave()
  fs.rmSync(base, { recursive: true, force: true })
  console.log('SMOKE OK')
}

main().catch((err) => {
  console.error('SMOKE FAIL', err)
  process.exit(1)
})
