import { NextRequest, NextResponse } from 'next/server';
import { WebSocket as ClientWebSocket } from 'ws';
import { registerCall } from '@/lib/callRegistry';
import { markDialInitiator } from '@/lib/dialRegistry';
import { listAgentConfigs } from '@/lib/agentConfigs';
import { eventBus } from '@/lib/eventBus';

/**
 * Dev-only simulator.
 *
 * Without real Plivo numbers + ngrok, the voice WebSocket never opens, so the
 * dashboard sits idle. This endpoint fakes two Plivo Stream clients connecting
 * to /voice/:call_uuid and lets the rest of the pipeline run end-to-end against
 * stub Plivo/LLM/STT/TTS.
 *
 * Trick: each leg's outbound `sendDTMF` event gets forwarded to the peer leg
 * as an inbound `dtmf` event (see `bridgeSendDtmf`). That's exactly what a
 * Dial bridge between two endpoints does, so the simulator exercises the SAME
 * in-band nonce handshake that real bridged calls run — the only difference
 * is who ferries the DTMF (this bridge vs Plivo's PSTN bridge).
 *
 * Two modes:
 *
 *   - LOCAL (empty body): both legs handled by THIS process. Exercises the
 *     single-middleware centralized orchestrator.
 *
 *   - FEDERATED (body { peerBase: "http://localhost:3001" }): our leg is
 *     handled by this process, the peer leg by the middleware at peerBase
 *     (which must run with its own AGENT_OWNED). Exercises the DEFAULT demo
 *     topology end-to-end with zero Plivo cost: in-band handshake across
 *     instances, signed HTTP pairing at the broker, per-leg solo paired
 *     mode, data relay.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { peerBase?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body */
  }

  return body.peerBase ? simulateFederated(body.peerBase) : simulateLocal();
}

// ----- Local mode (single middleware owns both agents) -----------------------

async function simulateLocal(): Promise<NextResponse> {
  const [agentA, agentB] = listAgentConfigs();
  if (!agentA || !agentB) {
    return NextResponse.json(
      { error: 'need_two_agents', hint: 'AGENT_OWNED is set — pass { peerBase } for a federated sim' },
      { status: 400 },
    );
  }

  const callA = `sim-A-${Date.now()}`;
  const callB = `sim-B-${Date.now()}`;
  registerCall(callA, agentA.number);
  registerCall(callB, agentB.number);
  // Leg A plays the Dial-originator: it proactively emits the DTMF preamble;
  // leg B is a responder and only answers after hearing it — same roles a
  // real bridged call gets from /api/answer's claimDialTarget.
  markDialInitiator(callA);

  const port = process.env.PORT ?? 3000;
  const wsA = new ClientWebSocket(`ws://localhost:${port}/voice/${callA}`);
  const wsB = new ClientWebSocket(`ws://localhost:${port}/voice/${callB}`);

  wireBridge({ wsA, wsB, callA, callB, callerNumber: agentA.number, calleeNumber: agentB.number });

  return NextResponse.json({
    ok: true,
    mode: 'local',
    callA,
    callB,
    notice: 'simulator running — watch /api/events',
  });
}

// ----- Federated mode (peer leg lives on another middleware) -----------------

async function simulateFederated(peerBase: string): Promise<NextResponse> {
  const [agentA] = listAgentConfigs();
  if (!agentA) {
    return NextResponse.json({ error: 'no_local_agent' }, { status: 400 });
  }

  const base = peerBase.replace(/\/$/, '');
  const callA = `sim-A-${Date.now()}`;
  const callB = `sim-B-${Date.now()}`;

  // Ask the peer middleware to register its sim leg BEFORE we open the
  // voice WS to it (its voiceHandler needs the callRegistry entry).
  let peerNumber: string;
  try {
    const res = await fetch(`${base}/api/simulate-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callUuid: callB }),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: 'peer_register_failed', status: res.status },
        { status: 502 },
      );
    }
    const json = (await res.json()) as { number?: string };
    if (!json.number) {
      return NextResponse.json({ error: 'peer_returned_no_number' }, { status: 502 });
    }
    peerNumber = json.number;
  } catch (err) {
    return NextResponse.json(
      { error: 'peer_unreachable', detail: (err as Error).message },
      { status: 502 },
    );
  }

  registerCall(callA, agentA.number);
  markDialInitiator(callA); // we're the "dialing" side; the peer responds

  const port = process.env.PORT ?? 3000;
  const peerWsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const wsA = new ClientWebSocket(`ws://localhost:${port}/voice/${callA}`);
  const wsB = new ClientWebSocket(`${peerWsBase}/voice/${callB}`);

  wireBridge({ wsA, wsB, callA, callB, callerNumber: agentA.number, calleeNumber: peerNumber });

  return NextResponse.json({
    ok: true,
    mode: 'federated',
    callA,
    callB,
    peerBase: base,
    notice: 'federated simulator running — watch /api/events on both instances',
  });
}

// ----- Shared plumbing --------------------------------------------------------

function wireBridge(args: {
  wsA: ClientWebSocket;
  wsB: ClientWebSocket;
  callA: string;
  callB: string;
  callerNumber: string;
  calleeNumber: string;
}): void {
  const { wsA, wsB, callA, callB, callerNumber, calleeNumber } = args;

  // The real Plivo intercepts outbound `sendDTMF` events and synthesizes DTMF
  // tones onto the call. In sim mode there's no Plivo, so we shuttle each
  // outbound `sendDTMF` from one leg into the peer leg as inbound `dtmf`
  // events — exactly mirroring production behavior.
  bridgeSendDtmf(wsA, wsB);
  bridgeSendDtmf(wsB, wsA);

  // Once both client WSes are open, emit a 'start' event mimicking Plivo's
  // Stream protocol — purely cosmetic for the handlers; they wait for DTMF.
  Promise.all([waitOpen(wsA), waitOpen(wsB)])
    .then(async () => {
      eventBus.publishDemo({
        kind: 'call.triggered',
        callerNumber,
        calleeNumber,
        ts: Date.now(),
      });
      const startA = { event: 'start', start: { callId: callA, mediaFormat: { encoding: 'mulaw', sampleRate: 8000 } } };
      const startB = { event: 'start', start: { callId: callB, mediaFormat: { encoding: 'mulaw', sampleRate: 8000 } } };
      wsA.send(JSON.stringify(startA));
      wsB.send(JSON.stringify(startB));
    })
    .catch((err) => console.warn('[simulate] open error', err));
}

function waitOpen(ws: ClientWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** Forward each outbound `sendDTMF` on `src` as inbound `dtmf` events on `dst`. */
function bridgeSendDtmf(src: ClientWebSocket, dst: ClientWebSocket): void {
  src.on('message', async (data: Buffer | string) => {
    let parsed: { event?: string; dtmf?: string };
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    if (parsed.event !== 'sendDTMF' || typeof parsed.dtmf !== 'string') return;
    for (const digit of parsed.dtmf) {
      if (dst.readyState !== dst.OPEN) return;
      dst.send(JSON.stringify({ event: 'dtmf', dtmf: { digit } }));
      await new Promise((r) => setTimeout(r, 30));
    }
  });
}
