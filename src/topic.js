import crypto from 'hypercore-crypto'
import b4a from 'b4a'

/** Well-known rooms shipped with Omachat. */
export const ROOMS = {
  lobby: {
    id: 'lobby',
    title: 'Lobby',
    blurb: 'General Omarchy hangout'
  },
  ideas: {
    id: 'ideas',
    title: 'Ideas',
    blurb: 'Features & wild pitches'
  },
  help: {
    id: 'help',
    title: 'Help',
    blurb: 'Troubleshooting'
  },
  ai: {
    id: 'ai',
    title: 'AI',
    blurb: 'Agents, skills, Cursor'
  }
}

export const DEFAULT_ROOM = 'lobby'

const PREFIX = 'omachat:v1:'

/** 32-byte Hyperswarm topic for a room name. */
export function roomTopic(roomId) {
  const id = normalizeRoom(roomId)
  return crypto.hash(b4a.from(PREFIX + id))
}

export function normalizeRoom(roomId) {
  const raw = String(roomId || DEFAULT_ROOM).trim().toLowerCase().replace(/^#/, '')
  if (!raw || raw.length > 32) return DEFAULT_ROOM
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) return DEFAULT_ROOM
  return raw
}

export function listRooms() {
  return Object.values(ROOMS)
}
