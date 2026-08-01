/**
 * Data WebSocket relay between two paired agents.
 *
 * Each side of the paired call opens a client WebSocket to /data/:sessionId.
 * This handler accepts those two connections and forwards every message from
 * one side to the other.
 */

import type { WebSocket } from 'ws';
import { joinSession, leaveSession, peersInSession } from './dataChannels';
import { eventBus } from '@/lib/eventBus';
import type { AgentJsonMessage } from '@/types';

export async function handleDataConnection(ws: WebSocket, sessionId: string): Promise<void> {
  joinSession(sessionId, ws);
  console.log(`[data] join session=${sessionId} peers=${peersInSession(sessionId).length}`);

  ws.on('message', (data: Buffer | string) => {
    const raw = typeof data === 'string' ? data : data.toString();

    // Demo introspection — best-effort, never fatal.
    try {
      const payload = JSON.parse(raw) as AgentJsonMessage & { from?: string };
      eventBus.publishDemo({
        kind: 'agent.message',
        from: payload.from ?? 'unknown',
        payload,
        ts: Date.now(),
      });
    } catch {
      /* opaque, just relay */
    }

    for (const peer of peersInSession(sessionId)) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(raw);
      }
    }
  });

  ws.on('close', () => {
    leaveSession(sessionId, ws);
    console.log(`[data] leave session=${sessionId} peers=${peersInSession(sessionId).length}`);
    // If one side hangs up, push a synthetic bye to the other to unblock.
    for (const peer of peersInSession(sessionId)) {
      if (peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'bye' }));
      }
    }
  });
}
