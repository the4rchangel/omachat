import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const NICK_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/

export function configDir() {
  return process.env.OMACHAT_CONFIG
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omachat')
}

export function validNick(nick) {
  return typeof nick === 'string' && NICK_RE.test(nick)
}

export function loadOrCreateIdentity() {
  const CONFIG_DIR = configDir()
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })

  const seedPath = path.join(CONFIG_DIR, 'identity.seed')
  const nickPath = path.join(CONFIG_DIR, 'nick')

  let seed
  if (fs.existsSync(seedPath)) {
    const hex = fs.readFileSync(seedPath, 'utf8').trim()
    seed = b4a.from(hex, 'hex')
    if (seed.byteLength !== 32) {
      throw new Error('Corrupt identity.seed - expected 32-byte hex')
    }
  } else {
    seed = crypto.randomBytes(32)
    fs.writeFileSync(seedPath, b4a.toString(seed, 'hex') + '\n', { mode: 0o600 })
  }

  const keyPair = crypto.keyPair(seed)
  let nick = null
  if (fs.existsSync(nickPath)) {
    nick = fs.readFileSync(nickPath, 'utf8').trim()
    if (!validNick(nick)) nick = null
  }

  return {
    seed,
    keyPair,
    nick,
    publicKeyHex: b4a.toString(keyPair.publicKey, 'hex'),
    nickPath,
    seedPath
  }
}

export function saveNick(nick) {
  if (!validNick(nick)) {
    throw new Error('Invalid nick: start with a letter; max 16; [A-Za-z0-9_-]')
  }
  const CONFIG_DIR = configDir()
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(CONFIG_DIR, 'nick'), nick + '\n', { mode: 0o600 })
  return nick
}
