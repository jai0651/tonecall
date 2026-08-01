/**
 * Resolve the broker URL used for cross-instance pairing and the data WS.
 *
 *   BROKER_URL=http://localhost:3000          (this middleware IS the broker)
 *   BROKER_URL=https://broker.example.com     (federate to a remote broker)
 *
 * Falls back to `http://localhost:${PORT}` if unset (legacy single-instance
 * setups).
 */

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}

export function brokerHttpUrl(path: string): string {
  const base = trimSlash(process.env.BROKER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Convert the broker URL into a WebSocket URL for `/data/<sessionId>`.
 * http → ws, https → wss.
 */
export function brokerWsUrl(path: string): string {
  const base = trimSlash(process.env.BROKER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`);
  const ws = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${ws}${path.startsWith('/') ? path : `/${path}`}`;
}
