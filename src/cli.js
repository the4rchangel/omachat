#!/usr/bin/env node
import { loadOrCreateIdentity, saveNick, validNick } from './identity.js'
import { DEFAULT_ROOM, normalizeRoom } from './topic.js'
import { runTui } from './tui.js'

function usage() {
  console.log(`omachat - peer-to-peer Omarchy chat (Hyperswarm + mDNS + Tailscale)

Usage:
  omachat [room]              join room (default: lobby)
  omachat --nick <name>       set nick then join
  omachat --help

Rooms: lobby, ideas, help, ai - or any custom name (the name is the invite).

Discovery layers (all on by default):
  Hyperswarm/DHT   global topic rendezvous
  mDNS/Avahi       same LAN instant find
  Tailscale        probe online tailnet peers on TCP 4177

Env:
  OMACHAT_CONFIG         override config dir (default: ~/.config/omachat)
  OMACHAT_PORT           direct listen port (default: 4177)
  OMACHAT_NO_MDNS=1      disable LAN mDNS
  OMACHAT_NO_TAILSCALE=1 disable Tailscale probing
`)
}

async function main(argv) {
  const args = [...argv]
  if (args.includes('-h') || args.includes('--help')) {
    usage()
    return
  }

  let nickArg = null
  const nickIdx = args.findIndex((a) => a === '--nick' || a === '-n')
  if (nickIdx !== -1) {
    nickArg = args[nickIdx + 1]
    args.splice(nickIdx, 2)
  }

  const roomId = normalizeRoom(args[0] || process.env.OMACHAT_ROOM || DEFAULT_ROOM)
  const identity = loadOrCreateIdentity()

  if (nickArg) {
    if (!validNick(nickArg)) {
      console.error('Invalid nick: letter first, max 16, [A-Za-z0-9_-]')
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
