/**
 * Session registry — the missing link between two paired voice WS handlers.
 *
 * After broker pairing resolves with a sessionId, each voice handler
 * registers its leg (config + WS + callUuid) here. Once both legs are
 * present, ONE of them claims the orchestrator role and drives the demo
 * across both legs (voice intro → switch → data exchange → voice goodbye).
 * The other handler just blocks until the orchestrator signals completion.
 *
 * Plivo emits a separate stream WS per "call_uuid" representation, so for a
 * single phone number we sometimes see two WS connections in flight. We
 * dedupe by `agentNumber` — first leg wins, duplicates close.
 *
 * Backed by `globalThis` so the Next.js API graph and the custom server's
 * import graph share the same map.
 */

import type { WebSocket as ServerWebSocket } from 'ws';
import type { AgentConfig } from '@/types';

export type LegInfo = {
  callUuid: string;
  config: AgentConfig;
  ws: ServerWebSocket;
};

type Session = {
  sessionId: string;
  conferenceName: string;
  legs: LegInfo[];
  orchestratorCallUuid: string | null;
  completionResolvers: Array<() => void>;
};

const G = globalThis as unknown as { __tonecall_sessions?: Map<string, Session> };
const sessions = (G.__tonecall_sessions ??= new Map<string, Session>());

/**
 * Register a leg with a session.
 * Returns:
 *   - registered=true if this leg is the first (or second) unique leg
 *   - registered=false if a leg for the same agent number is already present
 *     (the caller should close its WS quietly — it's a Plivo dup)
 */
export function registerSessionLeg(args: {
  sessionId: string;
  conferenceName: string;
  leg: LegInfo;
}): { session: Session; registered: boolean } {
  const { sessionId, conferenceName, leg } = args;
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      conferenceName,
      legs: [],
      orchestratorCallUuid: null,
      completionResolvers: [],
    };
    sessions.set(sessionId, session);
  }

  // Dedupe by agent number — Plivo emits multiple WS per call leg sometimes.
  const dup = session.legs.find((l) => l.config.number === leg.config.number);
  if (dup) {
    return { session, registered: false };
  }

  session.legs.push(leg);
  return { session, registered: true };
}

export function getSession(sessionId: string): Session | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * Atomically claim the orchestrator role for this session. Only one caller
 * succeeds. The "loser" should wait for completion instead of driving the
 * demo itself.
 */
export function claimOrchestrator(sessionId: string, callUuid: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.orchestratorCallUuid) return false;
  session.orchestratorCallUuid = callUuid;
  return true;
}

export function signalDemoComplete(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const resolve of session.completionResolvers) resolve();
  session.completionResolvers = [];
  sessions.delete(sessionId);
}

export function waitForDemoComplete(sessionId: string, ws: ServerWebSocket): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve();
  return new Promise<void>((resolve) => {
    session.completionResolvers.push(resolve);
    // Also resolve if our WS closes — caller wants out either way.
    ws.once('close', () => resolve());
  });
}
