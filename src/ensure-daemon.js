import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteSession } from './remote-session.js'
import { socketPath } from './ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_JS = path.join(__dirname, 'daemon.js')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * If the daemon socket is down, start it (systemd user unit preferred,
 * otherwise a detached node process) and wait until we can attach.
 */
export async function ensureDaemonRunning({
  waitMs = 25000,
  pollMs = 400
} = {}) {
  if (process.env.OMACHAT_NO_AUTO_DAEMON === '1') {
    return RemoteSession.tryConnect({ timeoutMs: 400 })
  }

  let remote = await RemoteSession.tryConnect({ timeoutMs: 350 })
  if (remote) return remote

  // Prefer the installed user service so the tray comes back too.
  const startedSystemd = await run('systemctl', ['--user', 'start', 'omachat.service'])
  if (startedSystemd) {
    await run('systemctl', ['--user', 'start', 'omachat-tray.service'])
  } else {
    // No unit / systemctl unavailable — spawn the daemon ourselves.
    try {
      const child = spawn(process.execPath, [DAEMON_JS], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      child.unref()
    } catch {
      return null
    }
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    // Stale socket file with no listener
    if (fs.existsSync(socketPath())) {
      remote = await RemoteSession.tryConnect({ timeoutMs: 500 })
      if (remote) return remote
    }
    await sleep(pollMs)
  }

  return RemoteSession.tryConnect({ timeoutMs: 500 })
}
