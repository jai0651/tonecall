/**
 * Per-call state machine — AVIP-1 (Agent Voice Interop Protocol v1) handshake.
 *
 * AVIP has ONE job: when two AI agents land on the same call, give them a
 * structured JSON channel and a shared session id. Everything else
 * (orchestration, voice fallback, demo flow) hangs off that pairing.
 *
 * Pairing is IN-BAND on every real call: each side generates an 8-digit
 * nonce and plays the preamble `9090<nonce>#` as DTMF over the call
 * (Plivo `sendDTMF` stream event), and listens for the peer's preamble on
 * its own stream's `dtmf` events. Both sides then submit cross-wise nonces
 * to the broker, which matches them into a session. Because the signal
 * travels over the call itself, this works across vendors and across
 * middlewares — no shared process state.
 *
 * Roles come from the call topology (dialRegistry):
 *   - initiator  — the leg that <Dial>ed out. Proactively emits its
 *     preamble, re-emitting until the peer answers (the Dial bridge takes
 *     a few seconds to come up).
 *   - responder  — a dialed-into or inbound leg. Emits only AFTER hearing
 *     a preamble, so a human caller never hears unsolicited beeps.
 *
 * No signal inside the handshake window ⇒ the peer is human ⇒ fall through
 * to the STT → LLM → TTS voice loop.
 */

import type { WebSocket } from 'ws';
import type { AgentConfig } from '@/types';
import { buildPreamble, generateNonce, PreambleDetector } from '@/lib/dtmf';
import { sendDtmfOverStream } from '@/lib/audio';
import { plivoClient } from '@/lib/plivo';
import { eventBus } from '@/lib/eventBus';
import { dtmfBus } from '@/lib/dtmfBus';
import { getDialRole, type DialRole } from '@/lib/dialRegistry';
import { buildSignedPairRequest, type PairRequest } from '@/lib/pairAuth';
import {
  registerSessionLeg,
  claimOrchestrator,
  waitForDemoComplete,
  getSession,
} from '@/lib/sessionRegistry';
import { runVoiceMode } from './voiceMode';
import { requestPairing } from './broker';
import { runDemoFlow } from './demoFlow';
import { runSoloPairedMode } from './pairedMode';

// Responder legs: how long to listen before concluding the caller is human.
// An initiator's preamble lands within ~1–4s of the bridge coming up.
const HANDSHAKE_TIMEOUT_MS = Number(process.env.HANDSHAKE_TIMEOUT_MS ?? 8_000);
// Initiator legs: must additionally cover the <Dial> ring time before the
// bridge even exists, so the window is wider.
const INITIATOR_HANDSHAKE_TIMEOUT_MS = Number(
  process.env.INITIATOR_HANDSHAKE_TIMEOUT_MS ?? 20_000,
);
const PAIR_HTTP_TIMEOUT_MS = 12_000; // must exceed broker's PAIR_TIMEOUT_MS

export type StateMachineArgs = {
  ws: WebSocket;
  callUuid: string;
  config: AgentConfig;
};

// Per-agent-number lock. Plivo emits TWO call_uuids per PSTN leg (a
// bookkeeping twin pair). Without dedupe, BOTH twins would run the
// handshake and the duplicate would compete for the orchestrator.
const handshakeInProgress = (globalThis as unknown as {
  __tonecall_handshake_lock?: Map<string, string>;
}).__tonecall_handshake_lock ??= new Map<string, string>();

export async function runStateMachine(args: StateMachineArgs): Promise<void> {
  const { ws, callUuid, config } = args;

  const existing = handshakeInProgress.get(config.number);
  if (existing && existing !== callUuid) {
    console.log(
      `[handshake] duplicate ws for ${config.number} (other=${existing}), parking call=${callUuid}`,
    );
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
    return;
  }
  handshakeInProgress.set(config.number, callUuid);

  try {
    await runStateMachineInner(args);
  } finally {
    if (handshakeInProgress.get(config.number) === callUuid) {
      handshakeInProgress.delete(config.number);
    }
  }
}

async function runStateMachineInner(args: StateMachineArgs): Promise<void> {
  const { ws, callUuid, config } = args;

  eventBus.publishDemo({ kind: 'handshake.started', callUuid, ts: Date.now() });

  const role = getDialRole(callUuid);
  const timeoutMs =
    role === 'initiator' ? INITIATOR_HANDSHAKE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS;

  const nonce = await runInBandNonceHandshake({
    ws,
    callUuid,
    agentNumber: config.number,
    role,
    timeoutMs,
  });

  if (!nonce) {
    // No AVIP preamble inside the window ⇒ the peer is a human (or a non-AVIP
    // system). Run the normal voice agent. This is the graceful floor: the
    // protocol's worst case is "behave like any phone AI".
    console.log(`[handshake] no peer signal call=${callUuid} role=${role}; voice mode`);
    eventBus.publishDemo({ kind: 'call.mode', callUuid, mode: 'human_to_agent', ts: Date.now() });
    eventBus.publishDemo({ kind: 'handshake.timeout', callUuid, ts: Date.now() });
    await runVoiceMode({ ws, callUuid, config });
    return;
  }

  eventBus.publishDemo({ kind: 'call.mode', callUuid, mode: 'agent_to_agent', ts: Date.now() });
  eventBus.publishDemo({
    kind: 'handshake.peer_detected',
    callUuid,
    peerNonce: nonce.peerNonce,
    ts: nonce.peerNonceAt,
  });

  const sessionId = await pairViaBroker({
    callUuid,
    myNonce: nonce.myNonce,
    peerNonce: nonce.peerNonce,
    agentNumber: config.number,
  });
  if (!sessionId) {
    console.warn(`[handshake] broker pair failed call=${callUuid}, hanging up`);
    await plivoClient.hangup(callUuid, config.accountId).catch(() => {});
    return;
  }
  console.log(
    `[handshake] paired via in-band nonce call=${callUuid} role=${role} session=${sessionId}`,
  );

  eventBus.publishDemo({
    kind: 'pairing.summary',
    callUuid,
    sessionId,
    path: 'in_band_nonce',
    ts: Date.now(),
  });

  // Register THIS leg into the session. If our number already has a leg,
  // we're the duplicate twin — park until the demo completes.
  const { registered } = registerSessionLeg({
    sessionId,
    conferenceName: 'avip1-dial',
    leg: { callUuid, config, ws },
  });
  if (!registered) {
    console.log(`[handshake] duplicate leg for ${config.number}, parking call=${callUuid}`);
    await waitForDemoComplete(sessionId, ws);
    return;
  }

  // Orchestrator vs participant.
  //
  // Federated (the default demo — each middleware owns ONE leg): the peer
  // leg never appears in this process, so after the grace window each
  // middleware drives ITS OWN side of the exchange via runSoloPairedMode.
  //
  // Single-middleware (both legs in this process): one leg claims the
  // orchestrator and drives the full 4-phase flow centrally; the other
  // parks. Kept for the one-box dev loop and its cost/latency metrics.
  const isOrchestrator = claimOrchestrator(sessionId, callUuid);
  if (isOrchestrator) {
    const haveBothLegs = await waitForLocalPeer(sessionId, 1500);
    if (haveBothLegs) {
      console.log(`[handshake] orchestrator (centralized) call=${callUuid} session=${sessionId}`);
      await runDemoFlow({ sessionId });
    } else {
      console.log(`[handshake] federated solo call=${callUuid} session=${sessionId} role=${role}`);
      await runSoloPairedMode({ ws, callUuid, config, sessionId, role });
    }
  } else {
    console.log(`[handshake] participant — waiting for orchestrator call=${callUuid} session=${sessionId}`);
    await waitForDemoComplete(sessionId, ws);
  }
}

/** Resolve as soon as the session has ≥2 legs locally, or after timeout. */
async function waitForLocalPeer(sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = getSession(sessionId);
    if (session && session.legs.length >= 2) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  const session = getSession(sessionId);
  return !!session && session.legs.length >= 2;
}

// ----- In-band nonce handshake --------------------------------------------

/**
 * Play our preamble via Plivo's `sendDTMF` event; subscribe to the per-number
 * dtmf bus for the peer's preamble; resolve when BOTH have happened (we've
 * sent ours AND we've seen theirs). Resolves to null on timeout.
 *
 * The initiator emits proactively and re-emits on an interval — early
 * bursts are lost while the Dial bridge is still ringing, so repetition is
 * what makes the handshake robust to connect-time variance. The responder
 * stays silent until it hears a preamble (humans never get beeped at), then
 * answers with its own.
 */
const INITIATOR_FIRST_EMIT_MS = 500;
const REEMIT_INTERVAL_MS = Number(process.env.PREAMBLE_INTERVAL_MS ?? 4_000);

async function runInBandNonceHandshake(args: {
  ws: WebSocket;
  callUuid: string;
  agentNumber: string;
  role: DialRole;
  timeoutMs: number;
}): Promise<{ myNonce: string; peerNonce: string; peerNonceAt: number } | null> {
  const { ws, callUuid, agentNumber, role, timeoutMs } = args;
  const myNonce = generateNonce();
  const preamble = buildPreamble(myNonce);
  const isInitiator = role === 'initiator';

  console.log(
    `[handshake] in-band call=${callUuid} number=${agentNumber} role=${role} ` +
      `myNonce=${myNonce} preamble="${preamble}" window=${timeoutMs}ms`,
  );

  const detector = new PreambleDetector();

  return new Promise((resolve) => {
    let resolved = false;
    let hasEmitted = false;
    let peerNonce: string | null = null;
    let peerNonceAt = 0;

    const cleanup = () => {
      ws.off('close', onWsClose);
      unsubscribe();
      if (emitTimer) clearInterval(emitTimer);
      if (initialTimer) clearTimeout(initialTimer);
      clearTimeout(timeoutTimer);
    };

    const succeed = () => {
      if (resolved || !hasEmitted || !peerNonce) return;
      resolved = true;
      cleanup();
      resolve({ myNonce, peerNonce, peerNonceAt });
    };

    const fail = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    };

    const unsubscribe = dtmfBus.subscribe(agentNumber, (e) => {
      const detected = detector.feed(e.digit);
      if (detected && detected !== myNonce) {
        peerNonce = detected;
        peerNonceAt = Date.now();
        if (!hasEmitted) fireEmit(); // responder: answer now that we've heard the initiator
        succeed();
      }
    });

    const onWsClose = () => fail();
    ws.once('close', onWsClose);

    const fireEmit = () => {
      if (resolved) return;
      try {
        if (ws.readyState === ws.OPEN) sendDtmfOverStream(ws, preamble);
      } catch (err) {
        console.warn(`[handshake] sendDTMF failed call=${callUuid}`, err);
      }
      console.log(`[handshake] emitted preamble call=${callUuid} nonce=${myNonce}`);
      hasEmitted = true;
      succeed();
    };

    const initialTimer = isInitiator ? setTimeout(fireEmit, INITIATOR_FIRST_EMIT_MS) : null;
    const emitTimer = isInitiator ? setInterval(fireEmit, REEMIT_INTERVAL_MS) : null;

    const timeoutTimer = setTimeout(fail, timeoutMs);
  });
}

// ----- Broker pairing -------------------------------------------------------

/**
 * Submit our (myNonce, peerNonce) evidence to the broker.
 *
 * BROKER_URL unset ⇒ this process IS the broker (single-middleware / dev):
 * match in-process. BROKER_URL set ⇒ POST the signed request over HTTP —
 * the federated path, where each middleware owns one leg and only the
 * broker instance sees both submissions.
 */
async function pairViaBroker(args: PairRequest): Promise<string | null> {
  if (!process.env.BROKER_URL) {
    try {
      return await requestPairing(args);
    } catch (err) {
      console.warn(`[pair] in-process pairing failed:`, (err as Error).message);
      return null;
    }
  }

  const { brokerHttpUrl } = await import('@/lib/brokerUrl');
  const url = brokerHttpUrl('/api/pair');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSignedPairRequest(args)),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessionId?: string };
    return body.sessionId ?? null;
  } catch (err) {
    console.warn(`[pair] broker POST ${url} failed:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
