import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectDirect, DEFAULT_PORT, PORT_SPAN } from '../net/direct.js'

const execFileAsync = promisify(execFile)

/**
 * Probe online Tailscale peers on the Omachat direct port.
 * No Tailscale API beyond `tailscale status --json` - works when the daemon is up.
 */
export class TailscaleDiscovery extends EventEmitter {
  constructor({ roomId, identity, port, onSocket, intervalMs = 8000 }) {
    super()
    this.roomId = roomId
    this.identity = identity
    this.port = port || DEFAULT_PORT
    this.onSocket = onSocket
    this.intervalMs = intervalMs
    this.timer = null
    this.probed = new Set() // host:port attempted recently
    this.stopped = false
    this.selfIps = new Set()
    this.lastStatusKey = null
  }

  start() {
    this.#tick()
    this.timer = setInterval(() => this.#tick(), this.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  #emitStatus(ok, detail) {
    const key = `${ok}:${detail}`
    if (key === this.lastStatusKey) return
    this.lastStatusKey = key
    this.emit('status', { layer: 'tailscale', ok, detail })
  }

  async #tick() {
    if (this.stopped) return
    let status
    try {
      const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
        timeout: 4000,
        maxBuffer: 2 * 1024 * 1024
      })
      status = JSON.parse(stdout)
    } catch {
      this.#emitStatus(false, 'unavailable')
      return
    }

    if (status.BackendState !== 'Running') {
      this.#emitStatus(false, status.BackendState || 'unknown')
      return
    }

    for (const ip of status.TailscaleIPs || []) this.selfIps.add(ip)
    for (const ip of status.Self?.TailscaleIPs || []) this.selfIps.add(ip)

    const peers = Object.values(status.Peer || {})
    const online = peers.filter((p) => p.Online && (p.TailscaleIPs || []).length)
    this.#emitStatus(true, `${online.length} online peer${online.length === 1 ? '' : 's'}`)

    for (const peer of online) {
      if (this.stopped) return
      const ips = (peer.TailscaleIPs || []).filter((ip) => ip.includes('.') && !this.selfIps.has(ip))
      for (const ip of ips) {
        await this.#probeHost(ip, peer.HostName || ip)
      }
    }
  }

  async #probeHost(ip, label) {
    // Prefer configured port, then a short span in case of fallback bind.
    const ports = []
    for (let p = this.port; p < this.port + Math.min(4, PORT_SPAN); p++) ports.push(p)

    for (const port of ports) {
      const key = `${ip}:${port}`
      if (this.probed.has(key)) continue
      this.probed.add(key)
      // Allow re-probe later if peer comes online with omachat later.
      setTimeout(() => this.probed.delete(key), 60_000).unref?.()

      const socket = await connectDirect(ip, port, { via: 'tailscale', timeoutMs: 600 })
      if (!socket) continue

      this.emit('found', { via: 'tailscale', address: ip, port, label })
      this.onSocket(socket, { via: 'tailscale', label })
      return
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
