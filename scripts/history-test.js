#!/usr/bin/env node
/** Encrypt/decrypt history round-trip + append dedupe. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omachat-hist-'))
process.env.OMACHAT_CONFIG = tmp

const { HistoryStore, encrypt, decrypt, deriveHistoryKey } = await import('../src/history.js')

const seed = crypto.randomBytes(32)
const store = new HistoryStore(seed)

store.append('lobby', { id: 'a1', type: 'chat', ts: 1, nick: 'alice', body: 'hi', pk: 'pk' })
store.append('lobby', { id: 'a1', type: 'chat', ts: 1, nick: 'alice', body: 'hi', pk: 'pk' }) // dup
store.append('lobby', { id: 'a2', type: 'chat', ts: 2, nick: 'bob', body: 'yo', pk: 'pk2' })

const loaded = store.load('lobby')
assert.equal(loaded.length, 2)
assert.equal(loaded[0].body, 'hi')
assert.equal(loaded[1].body, 'yo')

const key = deriveHistoryKey(seed)
const blob = fs.readFileSync(path.join(tmp, 'history', 'lobby.bin'))
const plain = decrypt(key, blob)
assert.match(plain.toString(), /"hi"/)

const other = new HistoryStore(crypto.randomBytes(32))
assert.equal(other.load('lobby').length, 0)

const again = decrypt(key, encrypt(key, Buffer.from('ping')))
assert.equal(again.toString(), 'ping')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('HISTORY OK')
