#!/usr/bin/env node
/**
 * Headless check that Enter/return submits once and printable keys don't triple.
 * Uses a tiny stub of the input state machine (same rules as tui.js).
 */
let draft = ''
const sent = []

function onKey(ch, key) {
  if (key.ctrl && key.name === 'c') return 'quit'
  if (key.name === 'return' || key.name === 'enter') {
    if (!draft) return 'open-room'
    const line = draft
    draft = ''
    sent.push(line)
    return 'send'
  }
  if (key.name === 'backspace') {
    draft = draft.slice(0, -1)
    return
  }
  if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
    draft += ch
  }
}

function press(ch, name, extra = {}) {
  onKey(ch, { name, ctrl: false, meta: false, ...extra })
}

for (const c of 'hello') press(c, c)
press('\r', 'return')
if (sent.length !== 1 || sent[0] !== 'hello' || draft !== '') {
  console.error('FAIL return submit', { sent, draft })
  process.exit(1)
}

draft = ''
sent.length = 0
for (const c of 'hi') press(c, c)
press('\n', 'enter')
if (sent.length !== 1 || sent[0] !== 'hi') {
  console.error('FAIL enter submit', { sent, draft })
  process.exit(1)
}

draft = ''
sent.length = 0
press('h', 'h')
press('h', 'h')
press('h', 'h')
if (draft !== 'hhh') {
  console.error('FAIL expected single append per key', draft)
  process.exit(1)
}

console.log('TUI key rules OK')
