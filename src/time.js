/**
 * Format message timestamps for the TUI.
 * Uses the process local timezone (Date get* methods, not getUTC*).
 */

/** Local calendar date + time, e.g. 2026-09-19 13:16 */
export function formatTimestamp(ms = Date.now()) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '????-??-?? ??:??'

  const yyyy = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}`
}

/** @deprecated alias — prefer formatTimestamp */
export function tsShort(ms = Date.now()) {
  return formatTimestamp(ms)
}
