/**
 * ANSI-aware wrapping / width helpers for the TUI chat pane.
 */

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

export function visibleWidth(s) {
  return stripAnsi(s).length
}

/** Pad or hard-clip a single visual row to exactly `width` cells (ANSI-safe). */
export function fitWidth(s, width) {
  const str = String(s)
  const w = visibleWidth(str)
  if (w === width) return str
  if (w < width) return str + ' '.repeat(width - w)
  // Clip by visible chars, preserve leading ANSI, close with reset if needed
  let out = ''
  let vis = 0
  let i = 0
  while (i < str.length && vis < width) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      const end = str.indexOf('m', i)
      if (end === -1) break
      out += str.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += str[i]
    vis += 1
    i += 1
  }
  if (/\x1b\[/.test(out) && !out.endsWith('\x1b[0m')) out += '\x1b[0m'
  return out
}

/**
 * Word-wrap a string to `width` visible columns.
 * Prefers breaking on spaces; hard-breaks overlong tokens.
 * Continues ANSI SGR state across wrapped rows.
 */
export function wrapAnsi(text, width) {
  const src = String(text ?? '')
  if (width < 1) return ['']
  if (visibleWidth(src) <= width) return [src]

  const rows = []
  let row = ''
  let rowVis = 0
  let openSgr = '' // last SGR so continuations keep color
  let i = 0

  const flush = () => {
    if (!row && rows.length === 0) return
    let line = row
    if (openSgr && !line.startsWith('\x1b[')) line = openSgr + line
    if (openSgr && !line.includes('\x1b[0m')) line += '\x1b[0m'
    rows.push(line)
    row = ''
    rowVis = 0
  }

  while (i < src.length) {
    if (src[i] === '\x1b' && src[i + 1] === '[') {
      const end = src.indexOf('m', i)
      if (end === -1) break
      const seq = src.slice(i, end + 1)
      row += seq
      if (seq === '\x1b[0m' || seq === '\x1b[m') openSgr = ''
      else openSgr = seq
      i = end + 1
      continue
    }

    if (src[i] === '\n') {
      flush()
      i += 1
      continue
    }

    // Gather next word (non-space run) or single space
    if (src[i] === ' ') {
      if (rowVis + 1 > width) flush()
      if (rowVis === 0 && rows.length > 0) {
        // skip leading space on wrapped continuation
        i += 1
        continue
      }
      row += ' '
      rowVis += 1
      i += 1
      continue
    }

    let j = i
    let word = ''
    let wordVis = 0
    while (j < src.length && src[j] !== ' ' && src[j] !== '\n') {
      if (src[j] === '\x1b' && src[j + 1] === '[') {
        const end = src.indexOf('m', j)
        if (end === -1) break
        const seq = src.slice(j, end + 1)
        word += seq
        if (seq === '\x1b[0m' || seq === '\x1b[m') openSgr = ''
        else openSgr = seq
        j = end + 1
        continue
      }
      word += src[j]
      wordVis += 1
      j += 1
    }

    if (wordVis === 0) {
      i = j
      continue
    }

    if (wordVis > width) {
      // Hard-break overlong token
      if (rowVis > 0) flush()
      let k = 0
      let chunk = ''
      let chunkVis = 0
      while (k < word.length) {
        if (word[k] === '\x1b' && word[k + 1] === '[') {
          const end = word.indexOf('m', k)
          const seq = word.slice(k, end + 1)
          chunk += seq
          k = end + 1
          continue
        }
        if (chunkVis >= width) {
          rows.push(chunk + (openSgr ? '\x1b[0m' : ''))
          chunk = openSgr
          chunkVis = 0
        }
        chunk += word[k]
        chunkVis += 1
        k += 1
      }
      row = chunk
      rowVis = chunkVis
      i = j
      continue
    }

    if (rowVis > 0 && rowVis + wordVis > width) flush()
    if (rowVis === 0 && openSgr && !word.startsWith('\x1b[')) row = openSgr
    row += word
    rowVis += wordVis
    i = j
  }

  if (row || rows.length === 0) flush()
  return rows.length ? rows : ['']
}

/** Expand logical message lines into wrapped display rows for a pane width. */
export function wrapMessageList(lines, width) {
  const out = []
  for (const line of lines) {
    out.push(...wrapAnsi(line, width))
  }
  return out
}
