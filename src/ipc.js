import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function runtimeDir() {
  return process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `omachat-${os.userInfo().uid}`)
}

export function socketPath() {
  return process.env.OMACHAT_SOCK || path.join(runtimeDir(), 'omachat.sock')
}

export function pidPath() {
  return process.env.OMACHAT_PID || path.join(runtimeDir(), 'omachat.pid')
}

export function ensureRuntimeDir() {
  const dir = path.dirname(socketPath())
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Write one JSON object as a line. */
export function writeLine(stream, obj) {
  stream.write(JSON.stringify(obj) + '\n')
}

/**
 * Accumulate socket chunks into JSON lines; call onLine(obj) per parsed object.
 * Returns a data handler for the socket.
 */
export function lineReader(onLine) {
  let pending = ''
  return (buf) => {
    pending += buf.toString('utf8')
    let idx
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx).trim()
      pending = pending.slice(idx + 1)
      if (!line) continue
      try {
        onLine(JSON.parse(line))
      } catch {
        // drop malformed
      }
    }
  }
}
