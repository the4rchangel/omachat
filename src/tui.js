import { emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Room } from './room.js'
import { DEFAULT_ROOM, normalizeRoom, listRooms, roomTopic } from './topic.js'
import b4a from 'b4a'
import { saveNick, validNick } from './identity.js'

const ROOM_ORDER = ['lobby', 'ideas', 'help', 'ai']
const NICK_COL = 12
const ROOMS_W = 16
const PEOPLE_W = 16

const ESC = '\x1b['
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const GRAY = '\x1b[90m'

function tsShort(ms = Date.now()) {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

function roomLabel(id) {
  return `#${id}`
}

function notify(title, body) {
  try {
    spawn('omarchy-notification-send', [title, body], {
      stdio: 'ignore',
      detached: true
    }).unref()
  } catch {
    // optional
  }
}

function clampStr(s, n) {
  const str = String(s)
  if (str.length <= n) return str.padEnd(n)
  return str.slice(0, Math.max(0, n - 1)) + '...'
}

function visibleWidth(s) {
  // Strip ANSI for length checks.
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length
}

function fit(s, width) {
  const plain = String(s)
  if (visibleWidth(plain) <= width) {
    return plain + ' '.repeat(Math.max(0, width - visibleWidth(plain)))
  }
  // Truncate by plain chars (messages are mostly plain after we build them).
  const raw = plain.replace(/\x1b\[[0-9;]*m/g, '')
  return raw.slice(0, Math.max(0, width - 1)) + '...'
}

function logError(err, where = 'tui') {
  try {
    const dir = process.env.OMACHAT_CONFIG
      || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omachat')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'tui-error.log'),
      `[${new Date().toISOString()}] ${where}: ${err?.stack || err}\n`
    )
  } catch {
    // ignore
  }
}

/**
 * Senpai-inspired layout (no external TUI toolkit):
 *   rooms | chat | people
 *   status / input / legend
 *
 * One stdin keypress handler. One draft string. No focus/readInput races.
 */
export async function runTui({ identity, roomId = DEFAULT_ROOM }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Omachat TUI needs an interactive terminal')
  }

  let currentRoom = normalizeRoom(roomId)
  let room = null
  let quitting = false
  let draft = ''
  let roomCursor = 0
  const messages = [] // plain strings already formatted for chat pane
  let cols = process.stdout.columns || 80
  let rows = process.stdout.rows || 24
  let redrawQueued = false

  const out = process.stdout

  function knownRooms() {
    const ids = [...ROOM_ORDER]
    if (!ids.includes(currentRoom)) ids.push(currentRoom)
    return ids
  }

  function layout() {
    const legendH = 2
    const inputH = 1
    const statusH = 1
    const chrome = legendH + inputH + statusH
    const bodyH = Math.max(3, rows - chrome)
    const roomsW = Math.min(ROOMS_W, Math.max(10, Math.floor(cols * 0.18)))
    const peopleW = Math.min(PEOPLE_W, Math.max(10, Math.floor(cols * 0.18)))
    const chatW = Math.max(20, cols - roomsW - peopleW)
    return { bodyH, roomsW, peopleW, chatW, legendH, inputH, statusH }
  }

  function write(str) {
    out.write(str)
  }

  function hideCursor() {
    write(`${ESC}?25l`)
  }

  function showCursor() {
    write(`${ESC}?25h`)
  }

  function clearScreen() {
    write(`${ESC}2J${ESC}H`)
  }

  function move(r, c) {
    write(`${ESC}${r};${c}H`)
  }

  function queueRedraw() {
    if (redrawQueued || quitting) return
    redrawQueued = true
    setImmediate(() => {
      redrawQueued = false
      try {
        redraw()
      } catch (err) {
        logError(err, 'redraw')
      }
    })
  }

  function formatChatLine(msg) {
    const when = tsShort(msg.ts)
    const nick = clampStr(msg.nick || '?', NICK_COL)
    const mine = msg.local || msg.pk === identity.publicKeyHex
    const nickColored = mine ? `${GREEN}${nick}${RESET}` : `${CYAN}${nick}${RESET}`
    return `${GRAY}${when}${RESET} ${nickColored} ${msg.body || ''}`
  }

  function formatSystemLine(text, at = Date.now()) {
    const when = tsShort(at)
    const nick = clampStr('*', NICK_COL)
    return `${GRAY}${when} ${nick} ${text}${RESET}`
  }

  function pushSystem(text, at) {
    messages.push(formatSystemLine(text, at))
    if (messages.length > 1500) messages.splice(0, messages.length - 1200)
    queueRedraw()
  }

  function pushChat(msg) {
    messages.push(formatChatLine(msg))
    if (messages.length > 1500) messages.splice(0, messages.length - 1200)
    queueRedraw()
  }

  function peerLines() {
    const nicks = room?.peerNicks?.() || []
    const lines = [`${BOLD}${identity.nick}${RESET} ${GREEN}(you)${RESET}`]
    for (const n of nicks) {
      if (n !== identity.nick) lines.push(n)
    }
    if (nicks.length === 0) lines.push(`${GRAY}searching...${RESET}`)
    return lines
  }

  function statusText() {
    const peers = room?.peerCount ?? 0
    const d = room?.discoveryStatus?.() || {}
    const bits = []
    if (d.hyperswarm?.ok) bits.push('dht')
    if (d.mdns?.ok) bits.push('mdns')
    if (d.tailscale?.ok) bits.push('ts')
    const layers = bits.length ? bits.join('+') : 'connecting'
    return (
      `${GREEN}${BOLD}omachat${RESET} ${CYAN}${roomLabel(currentRoom)}${RESET}` +
      ` · ${peers}p · ${identity.nick}` +
      ` · ${GRAY}${layers}:${d.port || '-'}${RESET}`
    )
  }

  function redraw() {
    cols = process.stdout.columns || cols
    rows = process.stdout.rows || rows
    const L = layout()
    const rooms = knownRooms()
    roomCursor = Math.max(0, Math.min(roomCursor, rooms.length - 1))

    hideCursor()
    clearScreen()

    // Body rows
    for (let i = 0; i < L.bodyH; i++) {
      const row = i + 1

      // rooms column
      move(row, 1)
      if (i === 0) {
        write(`${DIM}${fit(' rooms', L.roomsW - 1)}${RESET}│`)
      } else {
        const idx = i - 1
        const id = rooms[idx]
        let cell = ' '.repeat(L.roomsW - 1)
        if (id) {
          const active = id === currentRoom
          const label = roomLabel(id)
          const mark = active ? `${GREEN}${BOLD}` : CYAN
          const cursor = idx === roomCursor ? '>' : ' '
          cell = fit(`${cursor}${label}`, L.roomsW - 1)
          write(`${mark}${cell}${RESET}`)
        } else {
          write(cell)
        }
        write('│')
      }

      // chat column
      const chatX = L.roomsW + 1
      move(row, chatX)
      if (i === 0) {
        write(`${DIM}${fit(` ${roomLabel(currentRoom)} `, L.chatW - 1)}${RESET}│`)
      } else {
        const chatLines = messages.slice(-(L.bodyH - 1))
        const line = chatLines[i - 1] || ''
        write(fit(line, L.chatW - 1))
        write('│')
      }

      // people column
      const peopleX = L.roomsW + L.chatW + 1
      move(row, peopleX)
      if (i === 0) {
        write(`${DIM}${fit(' people', L.peopleW)}${RESET}`)
      } else {
        const people = peerLines()
        const line = people[i - 1] || ''
        write(fit(line, L.peopleW))
      }
    }

    // status
    const statusRow = L.bodyH + 1
    move(statusRow, 1)
    write(fit(statusText(), cols))

    // input
    const inputRow = statusRow + 1
    move(inputRow, 1)
    const prompt = `${GREEN}>${RESET} `
    const usable = Math.max(1, cols - 2)
    const shown = draft.length > usable ? draft.slice(draft.length - usable) : draft
    write(fit(`${prompt}${shown}`, cols))

    // legend (two lines)
    move(inputRow + 1, 1)
    write(fit(
      `${GREEN}${BOLD}omachat${RESET} ${DIM}|${RESET} ${GREEN}Ctrl+N/P${RESET} rooms  ${GREEN}F1-F4${RESET} jump  ${GREEN}↑↓${RESET} select  ${GREEN}Enter${RESET} open/send`,
      cols
    ))
    move(inputRow + 2, 1)
    write(fit(
      `${DIM}|${RESET} ${GREEN}/join /peers /disco /nick /help${RESET}   ${GREEN}Ctrl+C${RESET} quit`,
      cols
    ))

    // place cursor in input
    const cursorCol = Math.min(cols, 3 + Math.min(draft.length, usable))
    move(inputRow, cursorCol)
    showCursor()
  }

  async function openRoom(id, { silent = false } = {}) {
    const next = normalizeRoom(id)
    if (room && next === currentRoom) return

    if (room) {
      try {
        await room.leave()
      } catch (err) {
        logError(err, 'leave')
      }
      room = null
    }

    currentRoom = next
    messages.length = 0
    const rooms = knownRooms()
    roomCursor = Math.max(0, rooms.indexOf(currentRoom))

    if (!silent) pushSystem(`joined ${roomLabel(currentRoom)}`)

    room = new Room({
      identity,
      roomId: currentRoom,
      enableMdns: process.env.OMACHAT_NO_MDNS !== '1',
      enableTailscale: process.env.OMACHAT_NO_TAILSCALE !== '1'
    })

    const lastDisco = new Map()

    room.on('joined', ({ port }) => {
      pushSystem(`listening · tcp :${port} · hyperswarm announced`)
    })

    room.on('discovery', (s) => {
      if (!s?.layer) return
      const key = `${s.ok}:${s.detail || ''}`
      if (lastDisco.get(s.layer) === key) return
      lastDisco.set(s.layer, key)
      if (s.layer === 'tailscale' && !s.ok) {
        queueRedraw()
        return
      }
      if (s.ok) pushSystem(`${s.layer}: ${s.detail}`)
      else queueRedraw()
    })

    room.on('peer', () => queueRedraw())

    room.on('presence', (msg) => {
      if (msg.pk === identity.publicKeyHex) return
      const via = msg.via ? ` via ${msg.via}` : ''
      pushSystem(`${msg.nick} is here${via}`, msg.ts)
    })

    room.on('system', (msg) => {
      pushSystem(msg.text, msg.ts)
    })

    room.on('chat', (msg) => {
      pushChat(msg)
      if (!(msg.local || msg.pk === identity.publicKeyHex) && identity.nick) {
        const mention = new RegExp(`(^|\\W)@?${identity.nick}\\b`, 'i')
        if (mention.test(msg.body || '')) {
          notify('Omachat mention', `${msg.nick}: ${msg.body}`)
        }
      }
    })

    await room.join()
    queueRedraw()
  }

  async function handleLine(line) {
    const text = String(line || '').trim()
    if (!text) return

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/)
      const arg = rest.join(' ').trim()
      switch (cmd.toLowerCase()) {
        case 'q':
        case 'quit':
        case 'exit':
          await shutdown()
          return
        case 'help':
        case '?':
          pushSystem('Ctrl+N/P next/prev room · F1-F4 jump · ↑↓ select room · Enter open room or send')
          pushSystem('/join /rooms /peers /disco /nick /topic /quit')
          return
        case 'rooms':
          for (const r of listRooms()) pushSystem(`${roomLabel(r.id).padEnd(10)} ${r.blurb}`)
          return
        case 'peers': {
          const nicks = room?.peerNicks() || []
          pushSystem(nicks.length ? nicks.join(', ') : 'no peers yet')
          return
        }
        case 'disco':
        case 'discovery':
        case 'status': {
          const d = room?.discoveryStatus() || {}
          pushSystem(`port ${d.port ?? '-'} · dht ${d.hyperswarm?.detail || '?'} · mdns ${d.mdns?.detail || '?'} · ts ${d.tailscale?.detail || '?'}`)
          return
        }
        case 'topic':
          pushSystem(b4a.toString(roomTopic(currentRoom), 'hex'))
          return
        case 'join':
        case 'room':
        case 'r':
          if (!arg) {
            pushSystem('usage: /join <room>')
            return
          }
          await openRoom(arg)
          return
        case 'nick':
        case 'name': {
          if (!validNick(arg)) {
            pushSystem('invalid nick (letter first, max 16, [A-Za-z0-9_-])')
            return
          }
          const old = identity.nick
          identity.nick = saveNick(arg)
          room?.announceNick(old)
          pushSystem(`nick ${old} → ${identity.nick}`)
          return
        }
        default:
          pushSystem('unknown command - /help')
      }
      return
    }

    if (!room) {
      pushSystem('not connected to a room yet')
      return
    }
    room.say(text)
  }

  async function shutdown() {
    if (quitting) return
    quitting = true
    try {
      await room?.leave()
    } catch (err) {
      logError(err, 'shutdown-leave')
    }
    cleanupTerminal()
    process.exit(0)
  }

  function cycleRoom(delta) {
    const rooms = knownRooms()
    roomCursor = (roomCursor + delta + rooms.length) % rooms.length
    queueRedraw()
  }

  function jumpRoom(n) {
    const rooms = knownRooms()
    const id = rooms[n - 1]
    if (id) openRoom(id).catch((err) => logError(err, 'jumpRoom'))
  }

  function openSelectedRoom() {
    const id = knownRooms()[roomCursor]
    if (id && id !== currentRoom) {
      openRoom(id).catch((err) => logError(err, 'openSelectedRoom'))
    }
  }

  function onKey(ch, key) {
    if (quitting) return
    if (!key) return

    try {
      // Quit
      if (key.ctrl && key.name === 'c') {
        shutdown()
        return
      }

      // Room navigation
      if (key.ctrl && key.name === 'n') {
        const rooms = knownRooms()
        const idx = rooms.indexOf(currentRoom)
        const next = rooms[(idx + 1) % rooms.length]
        openRoom(next).catch((err) => logError(err, 'ctrl-n'))
        return
      }
      if (key.ctrl && key.name === 'p') {
        const rooms = knownRooms()
        const idx = rooms.indexOf(currentRoom)
        const next = rooms[(idx - 1 + rooms.length) % rooms.length]
        openRoom(next).catch((err) => logError(err, 'ctrl-p'))
        return
      }

      if (key.name === 'f1') return jumpRoom(1)
      if (key.name === 'f2') return jumpRoom(2)
      if (key.name === 'f3') return jumpRoom(3)
      if (key.name === 'f4') return jumpRoom(4)

      if (key.name === 'up') {
        cycleRoom(-1)
        return
      }
      if (key.name === 'down') {
        cycleRoom(1)
        return
      }

      // Enter: if draft empty, open highlighted room; else send message
      if (key.name === 'return' || key.name === 'enter') {
        if (!draft) {
          openSelectedRoom()
          return
        }
        const line = draft
        draft = ''
        queueRedraw()
        handleLine(line).catch((err) => logError(err, 'handleLine'))
        return
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        if (draft.length) {
          draft = draft.slice(0, -1)
          queueRedraw()
        }
        return
      }

      if (key.name === 'escape') {
        draft = ''
        queueRedraw()
        return
      }

      // Printable character (ignore controls / meta)
      if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
        if (draft.length < 2000) {
          draft += ch
          queueRedraw()
        }
      }
    } catch (err) {
      logError(err, 'onKey')
    }
  }

  function cleanupTerminal() {
    try {
      process.stdin.removeListener('keypress', onKey)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      showCursor()
      write(`${RESET}\n`)
    } catch {
      // ignore
    }
  }

  // --- boot ---
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('keypress', onKey)

  process.stdout.on('resize', () => queueRedraw())

  process.on('uncaughtException', (err) => {
    logError(err, 'uncaughtException')
    pushSystem(`error: ${err.message || err}`)
  })
  process.on('unhandledRejection', (err) => {
    logError(err, 'unhandledRejection')
    pushSystem(`error: ${err?.message || err}`)
  })

  const onSignal = () => { shutdown() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  hideCursor()
  await openRoom(currentRoom, { silent: true })
  pushSystem(`welcome ${identity.nick}`)
  pushSystem('type a message and press Enter · /help for commands')
  queueRedraw()
}
