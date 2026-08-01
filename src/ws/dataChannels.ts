/**
 * Tracks live data WebSocket sessions.
 *
 * Each paired call has exactly two WebSocket clients (one per side of the
 * agent-to-agent conversation). Anything one sends, the other receives.
 *
 * Backed by globalThis — see callRegistry.ts for why.
 */

import type { WebSocket } from 'ws';

type Session = {
  sessionId: string;
  peers: WebSocket[];
};

const G = globalThis as unknown as { __tonecall_data_sessions?: Map<string, Session> };
const sessions = (G.__tonecall_data_sessions ??= new Map<string, Session>());

export function joinSession(sessionId: string, ws: WebSocket): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { sessionId, peers: [] };
    sessions.set(sessionId, session);
  }
  session.peers.push(ws);
  return session;
}

export function leaveSession(sessionId: string, ws: WebSocket): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.peers = session.peers.filter((p) => p !== ws);
  if (session.peers.length === 0) {
    sessions.delete(sessionId);
  }
}

export function peersInSession(sessionId: string): WebSocket[] {
  return sessions.get(sessionId)?.peers ?? [];
}
