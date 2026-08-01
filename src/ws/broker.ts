/**
 * In-process broker for pairing two voice-handler instances.
 *
 * Side A calls `requestPairing` with (callUuid, myNonce, peerNonce). Side B
 * does the same with the inverse nonces. When both arrive and cross-match,
 * both calls resolve with the same `sessionId`. Each side then connects to
 * /data/:sessionId — the dataHandler relays JSON between them.
 *
 * In federated mode only ONE middleware runs the broker; the other submits
 * over HTTP via /api/pair (which verifies the HMAC signature before calling
 * into here — see src/lib/pairAuth.ts).
 *
 * State is held on globalThis to survive Next.js's separate module graph.
 */

import { randomBytes } from 'crypto';
import { eventBus } from '@/lib/eventBus';

type PendingPair = {
  callUuid: string;
  myNonce: string;
  peerNonce: string;
  agentNumber: string;
  resolve: (sessionId: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

// Generous because legs POST at staggered times (initiator detects peer's
// preamble ~200ms in; responder doesn't emit until ~2.8s — its POST arrives
// later). Keep the first POST's pending entry alive long enough for the
// second leg to catch up.
const PAIR_TIMEOUT_MS = 10_000;

const G = globalThis as unknown as {
  __tonecall_pending_pairs?: Map<string, PendingPair>;
  __tonecall_sessions_for_nonces?: Map<string, string>;
};
const pending = (G.__tonecall_pending_pairs ??= new Map());
const sessionForNonces = (G.__tonecall_sessions_for_nonces ??= new Map());

function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function requestPairing(args: {
  callUuid: string;
  myNonce: string;
  peerNonce: string;
  agentNumber: string;
}): Promise<string> {
  const { callUuid, myNonce, peerNonce, agentNumber } = args;

  return new Promise<string>((resolve, reject) => {
    const peer = pending.get(peerNonce);
    if (peer && peer.peerNonce === myNonce) {
      const sessionId = randomBytes(8).toString('hex');
      const key = pairKey(myNonce, peerNonce);
      sessionForNonces.set(key, sessionId);

      clearTimeout(peer.timer);
      pending.delete(peerNonce);

      eventBus.publishDemo({
        kind: 'handshake.paired',
        callUuid,
        sessionId,
        ts: Date.now(),
      });

      peer.resolve(sessionId);
      resolve(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      pending.delete(myNonce);
      reject(new Error(`pair timeout: peer never arrived (callUuid=${callUuid})`));
    }, PAIR_TIMEOUT_MS);

    pending.set(myNonce, {
      callUuid,
      myNonce,
      peerNonce,
      agentNumber,
      resolve,
      reject,
      timer,
    });
  });
}
