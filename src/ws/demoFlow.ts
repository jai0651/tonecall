/**
 * Demo flow orchestrator.
 *
 * Runs the full agent-to-agent narrative across two paired Plivo legs:
 *
 *   Phase 1 — VOICE CONVERSATION    LLM-driven turns. Either agent can
 *                                   propose switching to data once it
 *                                   suspects the peer is also an AI.
 *   Phase 2 — DATA EXCHANGE         Existing JSON loop on /data/<sessionId>.
 *   Phase 3 — VOICE GOODBYE         Each agent crafts a goodbye line based
 *                                   on how the deal actually went.
 *   Phase 4 — HANGUP                Both legs hung up via Plivo REST.
 *
 * Nothing is scripted — every spoken line and every JSON message comes from
 * the LLM at runtime, with the agents' personas as the only fixed input.
 */

import type { WebSocket as ServerWebSocket } from 'ws';
import { WebSocket as ClientWebSocket } from 'ws';
import type { AgentConfig, AgentJsonMessage, PhaseName } from '@/types';
import { eventBus } from '@/lib/eventBus';
import { llm, type VoiceTurn } from '@/lib/llm';
import { plivoClient } from '@/lib/plivo';
import { getSession, signalDemoComplete, type LegInfo } from '@/lib/sessionRegistry';
import { speak } from './voiceTurn';

// Cost model used for the savings panel on the dashboard. Numbers are
// per-second rates assembled from Plivo (~$0.005/min for US PSTN), OpenAI
// TTS ($15/1M characters ≈ $0.005/sec of speech), Whisper ($0.006/min),
// and GPT-5.2 token costs. We don't try to be exact — the demo wants a
// directionally honest comparison, not a billing audit.
const COST_PER_SEC_VOICE_USD = 0.0035; // PSTN + TTS + STT + LLM per leg-second
const COST_PER_SEC_DATA_USD = 0.0008;  // just LLM tokens per second of exchange
const COST_PER_LEG_FIXED_USD = 0.0;    // (per-call connection overhead — folded in)

// Baseline assumption: a voice-only run of the same negotiation would have
// taken roughly the same number of turns as the data exchange, each turn
// costing the SAME as our observed voice turns above. If we didn't observe
// any voice turns (degenerate case), fall back to 4s/turn — the rule-of-thumb
// for STT + LLM + TTS round-trips across the industry.
const VOICE_BASELINE_SEC_PER_TURN_FALLBACK = 4.0;

const MAX_VOICE_TURNS = 4;       // keep the slow channel SHORT for demo punch
const DATA_PHASE_TIMEOUT_MS = 30_000;
const MAX_DATA_TURNS = 6;        // enough to close a real deal, not a saga
const VOICE_TURN_TAIL_MS = 200;

type DemoArgs = {
  sessionId: string;
};

export async function runDemoFlow({ sessionId }: DemoArgs): Promise<void> {
  const session = await waitForBothLegs(sessionId, 2000);
  if (!session || session.legs.length < 2) {
    console.warn(
      `[demo] session=${sessionId} never got 2 legs (got=${session?.legs.length ?? 0}), abandoning`,
    );
    return;
  }

  const [initiator, responder] = orderLegs(session.legs);

  console.log(
    `[demo] start session=${sessionId} initiator=${initiator.config.name} responder=${responder.config.name}`,
  );

  // Announce the call mode so the dashboard can label things correctly.
  for (const leg of session.legs) {
    eventBus.publishDemo({
      kind: 'call.mode',
      callUuid: leg.callUuid,
      mode: 'agent_to_agent',
      ts: Date.now(),
    });
  }

  let voiceHistory: VoiceTurn[] = [];
  let dataHistory: AgentJsonMessage[] = [];
  let voiceMs = 0;
  let dataMs = 0;
  let goodbyeMs = 0;
  let voiceTurns = 0;
  let dataTurns = 0;
  let goodbyeTurns = 0;

  try {
    const intro = await timePhase('voice_intro', async () => {
      const result = await runVoiceConversation(initiator, responder);
      return { result, turns: result.length };
    });
    voiceHistory = intro.result;
    voiceMs = intro.durationMs;
    voiceTurns = intro.turns;

    const data = await timePhase('data_exchange', async () => {
      const result = await runDataExchange(sessionId, initiator, responder, voiceHistory);
      // Exclude the synthetic system seed + hellos from the turn count so
      // "turns" reflects actual agent reasoning steps.
      const real = result.filter(
        (m) => m.type !== 'hello' && !(m.type === 'reply' && 'text' in m && m.text.startsWith('Voice transcript')),
      );
      return { result, turns: real.length };
    });
    dataHistory = data.result;
    dataMs = data.durationMs;
    dataTurns = data.turns;

    const gb = await timePhase('voice_goodbye', async () => {
      await runGoodbye(initiator, responder, voiceHistory, dataHistory);
      return { result: undefined, turns: 2 };
    });
    goodbyeMs = gb.durationMs;
    goodbyeTurns = gb.turns;
  } catch (err) {
    console.warn(`[demo] flow error session=${sessionId}`, err);
  } finally {
    publishSummary({ voiceMs, dataMs, goodbyeMs, voiceTurns, dataTurns, goodbyeTurns });
    await hangupAll(session.legs);
    signalDemoComplete(sessionId);
    console.log(`[demo] complete session=${sessionId}`);
  }
}

// ---- Metric helpers --------------------------------------------------------

async function timePhase<T>(
  phase: PhaseName,
  body: () => Promise<{ result: T; turns: number }>,
): Promise<{ result: T; durationMs: number; turns: number }> {
  const startedAt = Date.now();
  eventBus.publishDemo({ kind: 'phase.started', phase, ts: startedAt });
  const { result, turns } = await body();
  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;
  eventBus.publishDemo({ kind: 'phase.ended', phase, durationMs, turns, ts: endedAt });
  return { result, durationMs, turns };
}

function publishSummary(m: {
  voiceMs: number;
  dataMs: number;
  goodbyeMs: number;
  voiceTurns: number;
  dataTurns: number;
  goodbyeTurns: number;
}): void {
  const voiceTotalMs = m.voiceMs + m.goodbyeMs;
  const dataSec = m.dataMs / 1000;
  const voiceSec = voiceTotalMs / 1000;
  const voiceTotalTurns = m.voiceTurns + m.goodbyeTurns;

  // Derive a per-turn voice cost from THIS run. Falls back to industry
  // rule-of-thumb if we somehow got zero voice turns.
  const observedSecPerTurn = voiceTotalTurns > 0 ? voiceSec / voiceTotalTurns : 0;
  const baselineSecPerTurn = observedSecPerTurn > 0
    ? observedSecPerTurn
    : VOICE_BASELINE_SEC_PER_TURN_FALLBACK;

  // What a voice-only equivalent of the data exchange would have cost:
  // dataTurns × observed-voice-rate.
  const voiceBaselineSec = m.dataTurns * baselineSecPerTurn;
  const voiceBaselineMs = Math.round(voiceBaselineSec * 1000);

  const costUsdActual = +(
    voiceSec * COST_PER_SEC_VOICE_USD +
    dataSec * COST_PER_SEC_DATA_USD +
    COST_PER_LEG_FIXED_USD
  ).toFixed(4);
  // Baseline: same voice intro + goodbye, BUT the data exchange happened
  // over voice instead. So replace dataSec with voiceBaselineSec at voice rate.
  const costUsdBaseline = +(
    voiceSec * COST_PER_SEC_VOICE_USD +
    voiceBaselineSec * COST_PER_SEC_VOICE_USD
  ).toFixed(4);
  const costSavedUsd = +(costUsdBaseline - costUsdActual).toFixed(4);
  const latencySavedMs = voiceBaselineMs - m.dataMs;

  eventBus.publishDemo({
    kind: 'demo.summary',
    voiceMs: voiceTotalMs,
    dataMs: m.dataMs,
    voiceTurns: m.voiceTurns + m.goodbyeTurns,
    dataTurns: m.dataTurns,
    voiceBaselineMs,
    latencySavedMs,
    costUsdActual,
    costUsdBaseline,
    costSavedUsd,
    ts: Date.now(),
  });
}

// ----- Phase 1 — VOICE CONVERSATION ----------------------------------------

async function runVoiceConversation(initiator: LegInfo, responder: LegInfo): Promise<VoiceTurn[]> {
  systemMarker('— Voice phase: each agent generates its own lines —');

  const history: VoiceTurn[] = [];
  let nextSpeaker: LegInfo = initiator;
  let prevSpeaker: LegInfo = responder;
  let peerWantsToSwitch = false;
  let turnsTaken = 0;

  while (turnsTaken < MAX_VOICE_TURNS) {
    const speaker = nextSpeaker;
    const peer = prevSpeaker;
    const turnsRemaining = MAX_VOICE_TURNS - turnsTaken;

    let line;
    try {
      line = await llm.respondVoiceTurn({
        systemPrompt: speaker.config.prompt,
        myName: speaker.config.name,
        peerName: peer.config.name,
        history,
        turnsRemaining,
        peerWantsToSwitch,
      });
    } catch (err) {
      console.warn(`[demo] voice turn LLM failure speaker=${speaker.config.name}`, err);
      break;
    }

    if (line.speak) {
      history.push({ speaker: speaker.config.name, text: line.speak });
      await speak({
        ws: speaker.ws,
        speakerName: speaker.config.name,
        voice: speaker.config.voice,
        text: line.speak,
        tailMs: VOICE_TURN_TAIL_MS,
      });
    }

    turnsTaken += 1;

    // Once both sides have agreed to switch, drop out of the voice phase.
    if (line.wantsToSwitch && peerWantsToSwitch) {
      console.log(`[demo] both agents agreed to switch after ${turnsTaken} turns`);
      break;
    }

    peerWantsToSwitch = line.wantsToSwitch;
    // Alternate
    nextSpeaker = peer;
    prevSpeaker = speaker;
  }

  return history;
}

// ----- Phase 2 — DATA EXCHANGE ---------------------------------------------

async function runDataExchange(
  sessionId: string,
  initiator: LegInfo,
  responder: LegInfo,
  voiceHistory: VoiceTurn[],
): Promise<AgentJsonMessage[]> {
  systemMarker('— Data phase: JSON over WebSocket (the fast path) —');

  const aWs = await openDataChannel(sessionId);
  const bWs = await openDataChannel(sessionId);
  if (!aWs || !bWs) {
    console.warn(`[demo] failed to open data WS for session=${sessionId}`);
    aWs?.close();
    bWs?.close();
    return [];
  }

  try {
    return await runDualAgentExchange(initiator, responder, aWs, bWs, voiceHistory);
  } finally {
    try { aWs.close(); } catch { /* ignore */ }
    try { bWs.close(); } catch { /* ignore */ }
  }
}

/**
 * Run BOTH agents from the orchestrator, alternating LLM turns. We drive
 * both sides centrally (rather than letting each leg run its own loop) so
 * the conversation closes cleanly and the dashboard sees a clean stream.
 */
async function runDualAgentExchange(
  initiator: LegInfo,
  responder: LegInfo,
  initiatorWs: ClientWebSocket,
  responderWs: ClientWebSocket,
  voiceHistory: VoiceTurn[],
): Promise<AgentJsonMessage[]> {
  const history: AgentJsonMessage[] = [];

  // Seed the LLM with the voice transcript so it can pick up where they
  // left off. Encode it as a pseudo-message visible in history.
  const voiceContext: AgentJsonMessage = voiceHistory.length
    ? {
        type: 'reply',
        text:
          'Voice transcript so far:\n' +
          voiceHistory.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
      }
    : { type: 'hello', from: 'system', capabilities: [] };
  history.push(voiceContext);

  // Opening hellos — both agents announce themselves on the data channel.
  const helloInit: AgentJsonMessage = {
    type: 'hello',
    from: initiator.config.name,
    capabilities: initiator.config.capabilities,
  };
  const helloResp: AgentJsonMessage = {
    type: 'hello',
    from: responder.config.name,
    capabilities: responder.config.capabilities,
  };
  sendAndPublish(initiatorWs, initiator.config.name, helloInit);
  sendAndPublish(responderWs, responder.config.name, helloResp);
  history.push(helloInit, helloResp);

  let currentSpeaker: 'initiator' | 'responder' = 'initiator';
  let lastPeerMessage: AgentJsonMessage = helloResp;
  const deadline = Date.now() + DATA_PHASE_TIMEOUT_MS;

  for (let turn = 0; turn < MAX_DATA_TURNS; turn++) {
    if (Date.now() > deadline) break;

    const speaker = currentSpeaker === 'initiator' ? initiator : responder;
    const ws = currentSpeaker === 'initiator' ? initiatorWs : responderWs;

    let reply: AgentJsonMessage;
    try {
      reply = await llm.respondJson({
        systemPrompt: speaker.config.prompt,
        history,
        peerMessage: lastPeerMessage,
      });
    } catch (err) {
      console.warn(`[demo] llm error turn=${turn}`, err);
      break;
    }
    history.push(reply);
    sendAndPublish(ws, speaker.config.name, reply);

    if (reply.type === 'bye') break;
    lastPeerMessage = reply;
    currentSpeaker = currentSpeaker === 'initiator' ? 'responder' : 'initiator';
  }

  // Make sure both sides see a bye so the dataHandler relay closes cleanly.
  if (history[history.length - 1]?.type !== 'bye') {
    const bye: AgentJsonMessage = { type: 'bye' };
    sendAndPublish(initiatorWs, initiator.config.name, bye);
    sendAndPublish(responderWs, responder.config.name, bye);
    history.push(bye);
  }
  return history;
}

function sendAndPublish(ws: ClientWebSocket, from: string, payload: AgentJsonMessage): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify({ ...payload, from }));
    } catch {
      /* ignore */
    }
  }
  eventBus.publishDemo({ kind: 'agent.message', from, payload, ts: Date.now() });
}

async function openDataChannel(sessionId: string): Promise<ClientWebSocket | null> {
  const { brokerWsUrl } = await import('@/lib/brokerUrl');
  const url = brokerWsUrl(`/data/${sessionId}`);
  return await new Promise((resolve) => {
    const ws = new ClientWebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(null);
    }, 4000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ----- Phase 3 — VOICE GOODBYE ----------------------------------------------

async function runGoodbye(
  initiator: LegInfo,
  responder: LegInfo,
  voiceHistory: VoiceTurn[],
  dataHistory: AgentJsonMessage[],
): Promise<void> {
  systemMarker('— Voice phase resumes: agents sign off —');

  await speakGoodbye(initiator, voiceHistory, dataHistory);
  await speakGoodbye(responder, voiceHistory, dataHistory);
}

async function speakGoodbye(
  leg: LegInfo,
  voiceHistory: VoiceTurn[],
  dataHistory: AgentJsonMessage[],
): Promise<void> {
  const transcript = [
    voiceHistory.length
      ? 'Earlier voice transcript:\n' + voiceHistory.map((t) => `${t.speaker}: ${t.text}`).join('\n')
      : '(no prior voice turns)',
    'Data exchange JSON:',
    ...dataHistory.map((m) => '  ' + JSON.stringify(m)),
  ].join('\n');

  let text: string;
  try {
    text = await llm.respondText({
      systemPrompt:
        leg.config.prompt +
        '\n\nThe conversation has concluded. Generate a single-sentence spoken farewell ' +
        'that fits the outcome (deal closed / no deal / partial). Plain prose only — no JSON.',
      history: [],
      userText: transcript,
    });
  } catch (err) {
    console.warn(`[demo] goodbye llm error for ${leg.config.name}`, err);
    text = 'Thanks for the call — goodbye.';
  }

  await speak({
    ws: leg.ws,
    speakerName: leg.config.name,
    voice: leg.config.voice,
    text: text.trim() || 'Goodbye.',
    tailMs: VOICE_TURN_TAIL_MS,
  });
}

// ----- Phase 4 — HANGUP -----------------------------------------------------

async function hangupAll(legs: LegInfo[]): Promise<void> {
  await Promise.all(
    legs.map((leg) =>
      plivoClient.hangup(leg.callUuid, leg.config.accountId).catch((err) => {
        console.warn(`[demo] hangup failed call=${leg.callUuid}`, err);
      }),
    ),
  );
}

// ----- Helpers --------------------------------------------------------------

function systemMarker(text: string): void {
  eventBus.publishDemo({
    kind: 'voice.transcript',
    speaker: 'system',
    text,
    ts: Date.now(),
  });
}

async function waitForBothLegs(sessionId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = getSession(sessionId);
    if (session && session.legs.length >= 2) return session;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getSession(sessionId);
}

/**
 * Pick the initiator deterministically. We prefer `pizza_shop` (the procurer)
 * as the caller — it's the one with a concrete shopping list to fulfil.
 */
function orderLegs(legs: LegInfo[]): [LegInfo, LegInfo] {
  const pizza = legs.find((l) => l.config.name === 'pizza_shop');
  const veg = legs.find((l) => l.config.name === 'vegetable_vendor');
  if (pizza && veg) return [pizza, veg];
  return [legs[0], legs[1]];
}
