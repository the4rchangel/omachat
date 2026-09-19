import net from 'node:net'
import { EventEmitter } from 'node:events'

export const DEFAULT_PORT = Number(process.env.OMACHAT_PORT || 4177)
export const PORT_SPAN = 16

/**
 * TCP listener for LAN / Tailscale shortcut paths.
 * Same JSON-line framing as Hyperswarm connections - Room wires the protocol.
 */
export class DirectServer extends EventEmitter {
  constructor() {
    super()
    this.server = null
    this.port = null
    this.host = '0.0.0.0'
  }

  async listen(preferred = DEFAULT_PORT) {
    if (this.server) return this.port

    let lastErr = null
    for (let p = preferred; p < preferred + PORT_SPAN; p++) {
      try {
        await this.#tryListen(p)
        this.port = p
        this.emit('listening', { port: p })
        return p
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new Error('Could not bind Omachat direct port')
  }

  #tryListen(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true)
        this.emit('connection', socket, { via: 'direct' })
      })
      server.on('error', reject)
      server.listen(port, this.host, () => {
        server.removeListener('error', reject)
        server.on('error', (err) => this.emit('error', err))
        this.server = server
        resolve()
      })
    })
  }

  async close() {
    if (!this.server) return
    const server = this.server
    this.server = null
    this.port = null
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

/**
 * Outbound TCP connect with timeout. Resolves socket or null.
 */
export function connectDirect(host, port, { timeoutMs = 800, via = 'direct' } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false

    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', onErr)
      socket.removeListener('connect', onConnect)
      resolve(result)
    }

    const onErr = () => {
      socket.destroy()
      done(null)
    }

    const onConnect = () => {
      socket.setNoDelay(true)
      socket.via = via
      done(socket)
    }

    const timer = setTimeout(() => {
      socket.destroy()
      done(null)
    }, timeoutMs)

    socket.once('error', onErr)
    socket.once('connect', onConnect)
  })
}
