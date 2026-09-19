#!/usr/bin/env node
import { loadOrCreateIdentity, saveNick, validNick } from './identity.js'
import { DEFAULT_ROOM, normalizeRoom } from './topic.js'
import { runTui } from './tui.js'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function usage() {
  console.log(`omachat - peer-to-peer Omarchy chat (Hyperswarm + mDNS + Tailscale)

Usage:
  omachat [room]                 join / attach TUI (default: lobby)
  omachat --nick <name>          set nick then join
  omachat --daemon               run headless background daemon
  omachat --help

Rooms: lobby, ideas, help, ai - or any custom name (the name is the invite).

Background service (Omarchy tray):
  omachat service install        enable systemd user units + tray
  omachat service start|stop|status

Env:
  OMACHAT_CONFIG         override config dir (default: ~/.config/omachat)
  OMACHAT_PORT           direct listen port (default: 4177)
  OMACHAT_NO_MDNS=1      disable LAN mDNS
  OMACHAT_NO_TAILSCALE=1 disable Tailscale probing
  OMACHAT_NOTIFY=0       daemon: disable desktop notifications
`)
}

async function main(argv) {
  const args = [...argv]
  if (args.includes('-h') || args.includes('--help')) {
    usage()
    return
  }

  if (args[0] === 'service') {
    const script = path.join(__dirname, '..', 'bin', 'omachat-service')
    const child = spawn(script, args.slice(1), { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 1))
    return
  }

  if (args.includes('--daemon') || args[0] === 'daemon') {
    await import('./daemon.js')
    return
  }

  let nickArg = null
  const nickIdx = args.findIndex((a) => a === '--nick' || a === '-n')
  if (nickIdx !== -1) {
    nickArg = args[nickIdx + 1]
    args.splice(nickIdx, 2)
  }

  // strip flags already handled
  const filtered = args.filter((a) => a !== '--daemon')

  const roomId = normalizeRoom(filtered[0] || process.env.OMACHAT_ROOM || DEFAULT_ROOM)
  const identity = loadOrCreateIdentity()

  if (nickArg) {
    if (!validNick(nickArg)) {
      console.error('Invalid nick: letter first, max 24, [A-Za-z0-9_-]')
      process.exit(1)
    }
    identity.nick = saveNick(nickArg)
  }

  if (!identity.nick) {
    console.error('No username set. Run: omachat --nick YourName')
    console.error('Or use the omachat launcher (gum prompt).')
    process.exit(1)
  }

  await runTui({ identity, roomId })
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err)
  process.exit(1)
})
