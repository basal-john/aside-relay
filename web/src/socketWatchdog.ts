/** The server sends a ping every 20 s, so 50 s of silence means at least two missed heartbeats. */
export const SOCKET_SILENCE_LIMIT_MS = 50_000

/** How often the watchdog looks at the socket while the page is visible. */
export const SOCKET_WATCHDOG_INTERVAL_MS = 10_000

/** How long a foreground probe ping waits for any message before the socket counts as dead. */
export const SOCKET_PROBE_TIMEOUT_MS = 5_000

/**
 * Decides whether an open socket has gone silent and must be replaced.
 * A tick that comes much later than planned means the page was suspended, so buffered
 * messages may still be on their way and that tick never drops the socket.
 */
export const isSocketSilent = ({ lastMessageAt, lastTickAt, now, visible }: {
  lastMessageAt: number
  lastTickAt: number
  now: number
  visible: boolean
}) => {
  if (!visible) return false
  if (now - lastTickAt > SOCKET_WATCHDOG_INTERVAL_MS * 2) return false
  return now - lastMessageAt > SOCKET_SILENCE_LIMIT_MS
}
