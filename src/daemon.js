#!/usr/bin/env node
/**
 * Headless Omachat — stays joined to default rooms, encrypts history,
 * notifies on activity, and serves the TUI / tray over a Unix socket.
 */
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { loadOrCreateIdentity, saveNick, validNick } from './identity.js'
import { Session } from './session.js'
import { HistoryStore } from './history.js'
import { DEFAULT_ROOM, normalizeRoom } from './topic.js'
import { ensureRuntimeDir, socketPath, pidPath, writeLine, lineReader } from './ipc.js'

const ROOM_ORDER = ['lobby', 'ideas', 'help', 'ai']

function notify(title, body, critical = false) {
  try {
    const args = critical
      ? ['-u', 'critical', title, String(body).slice(0, 180)]
      : [title, String(body).slice(0, 180)]
    spawn('omarchy-notification-send', args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // optional
  }
}

function snapshot(session) {
  const rooms = {}
  for (const id of session.roomIds()) {
    const slot = session.slots.get(id)
    const room = slot?.room
    rooms[id] = {
      unread: slot?.unread || 0,
      peers: room?.peerCount ?? 0,
      nicks: room?.peerNicks?.() || [],
      disco: room?.discoveryStatus?.() || null,
      lines: slot?.lines || []
    }
  }
  return {
    focusId: session.focusId,
    nick: session.identity.nick,
    pk: session.identity.publicKeyHex,
    roomIds: session.roomIds(),
    rooms
  }
}

async function main() {
  ensureRuntimeDir()
  const sock = socketPath()
  const pidFile = pidPath()

  if (fs.existsSync(sock)) {
    try {
      fs.unlinkSync(sock)
    } catch {
      // ignore
    }
  }

  const identity = loadOrCreateIdentity()
  if (!identity.nick) {
    console.error('omachat-daemon: set a nick first (omachat --nick YourName)')
    process.exit(1)
  }

  const history = new HistoryStore(identity.seed)
  const session = new Session({ identity, history, subscribe: ROOM_ORDER })
  /** @type {Set<import('node:net').Socket>} */
  const clients = new Set()
  let notifyMode = process.env.OMACHAT_NOTIFY === '0' ? 'off' : 'on' // on | mentions | off
  let uiClients = 0
  let uiFocusId = null

  function broadcast(event) {
    for (const c of clients) {
      try {
        writeLine(c, event)
      } catch {
        // ignore
      }
    }
  }

  function shouldNotify(roomId) {
    if (notifyMode === 'off') return false
    // No TUI attached → notify for every room (that's why the daemon exists).
    if (uiClients === 0) return true
    // TUI is open on this room → skip toast (user can see it).
    return uiFocusId !== roomId
  }

  session.on('lines', (p) => broadcast({ event: 'lines', ...p, lines: session.lines(p.roomId) }))
  session.on('peer', (p) => broadcast({ event: 'peer', ...p }))
  session.on('unread', (p) => broadcast({ event: 'unread', ...p }))
  session.on('focus', (p) => broadcast({ event: 'focus', ...p }))
  session.on('chat', ({ roomId, msg }) => {
    const focused = uiClients > 0 && uiFocusId === roomId
    broadcast({ event: 'chat', roomId, focused, msg })
    if (!shouldNotify(roomId)) return
    const mine = msg.local || msg.pk === identity.publicKeyHex
    if (mine) return
    const mention = identity.nick
      ? new RegExp(`(^|\\W)@?${identity.nick}\\b`, 'i').test(msg.body || '')
      : false
    if (notifyMode === 'mentions' && !mention) return
    const title = mention ? `Omachat mention #${roomId}` : `Omachat #${roomId}`
    notify(title, `${msg.nick}: ${msg.body}`, mention)
  })

  await session.start(DEFAULT_ROOM)
  console.log(`[omachat-daemon] nick=${identity.nick} sock=${sock}`)

  const server = net.createServer((socket) => {
    clients.add(socket)
    let isUi = false
    socket.setEncoding('utf8')
    socket.on('close', () => {
      clients.delete(socket)
      if (isUi) {
        uiClients = Math.max(0, uiClients - 1)
        if (uiClients === 0) uiFocusId = null
      }
    })
    socket.on('error', () => {
      clients.delete(socket)
    })

    socket.on('data', lineReader(async (msg) => {
      const id = msg.id
      const reply = (ok, result, error) => {
        writeLine(socket, { id, ok, result, error })
      }

      try {
        switch (msg.cmd) {
          case 'ping':
            reply(true, { pong: true, pid: process.pid })
            break
          case 'status':
            reply(true, {
              ...snapshot(session),
              notifyMode,
              uiClients,
              uiFocusId,
              daemon: true
            })
            break
          case 'attach': {
            if (!isUi) {
              isUi = true
              uiClients += 1
            }
            if (msg.room) await session.focusRoom(msg.room)
            uiFocusId = session.focusId
            reply(true, snapshot(session))
            break
          }
          case 'focus':
            await session.focusRoom(msg.room || DEFAULT_ROOM)
            if (isUi) uiFocusId = session.focusId
            reply(true, { focusId: session.focusId })
            break
          case 'say': {
            if (msg.room && msg.room !== session.focusId) {
              await session.focusRoom(msg.room)
              if (isUi) uiFocusId = session.focusId
            }
            const sent = session.say(msg.body || '')
            reply(true, { sent: Boolean(sent), id: sent?.id })
            break
          }
          case 'pushSystem':
            session.pushSystem(msg.text || '', msg.ts, msg.room)
            reply(true, {})
            break
          case 'nick': {
            if (!validNick(msg.nick)) {
              reply(false, null, 'invalid nick')
              break
            }
            const old = identity.nick
            identity.nick = saveNick(msg.nick)
            session.announceNick(old)
            reply(true, { nick: identity.nick })
            break
          }
          case 'notify': {
            if (['on', 'mentions', 'off'].includes(msg.mode)) {
              notifyMode = msg.mode
            }
            reply(true, { mode: notifyMode })
            break
          }
          case 'quit':
            reply(true, { quitting: true })
            setTimeout(() => shutdown(0), 50)
            break
          default:
            reply(false, null, `unknown cmd ${msg.cmd}`)
        }
      } catch (err) {
        reply(false, null, err?.message || String(err))
      }
    }))
  })

  server.listen(sock, () => {
    try {
      fs.chmodSync(sock, 0o600)
    } catch {
      // ignore
    }
    fs.writeFileSync(pidFile, String(process.pid) + '\n', { mode: 0o600 })
    console.log(`[omachat-daemon] listening · watching ${ROOM_ORDER.join(',')}`)
  })

  async function shutdown(code = 0) {
    try {
      server.close()
    } catch {
      // ignore
    }
    try {
      await session.stop()
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(sock)
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(pidFile)
    } catch {
      // ignore
    }
    process.exit(code)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
