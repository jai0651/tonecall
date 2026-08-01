/**
 * Federated (solo) paired mode — each middleware drives ITS OWN leg.
 *
 * This is the honest AVIP flow: the two middlewares never share process
 * state. After the in-band handshake pairs them, each side independently:
 *
 *   1. Opens a client WebSocket to the broker's /data/:sessionId relay.
 *   2. Speaks a short LLM-generated voice intro on its own leg — with the
 *      Dial bridge, the peer (and any human eavesdropper) actually hears it.
 *   3. Runs the JSON exchange: initiator opens with `hello`, then the two
 *      sides alternate llm.respondJson turns until one says `bye`.
 *   4. Speaks a one-line voice goodbye summarizing the outcome.
 *   5. Hangs up its own leg.
 *
 * The initiator/responder role (from the dial topology) sequences the
 * conversation without any cross-middleware coordination: the initiator
 * speaks + sends hello first; the responder waits until it hears from the
 * peer, so the two sides never talk over each other.
 */

import type { WebSocket as ServerWebSocket } from 'ws';
import { WebSocket as ClientWebSocket } from 'ws';
import type { AgentConfig, AgentJsonMessage } from '@/types';
import type { DialRole } from '@/lib/dialRegistry';
import { llm } from '@/lib/llm';
import { plivoClient } from '@/lib/plivo';
import { eventBus } from '@/lib/eventBus';
import { speak } from './voiceTurn';

const MAX_TURNS = 12; // safety cap so a runaway loop can't burn budget
const DATA_WS_OPEN_TIMEOUT_MS = 4_000;

type Args = {
  ws: ServerWebSocket;
  callUuid: string;
  config: AgentConfig;
  sessionId: string;
  role?: DialRole;
};

export async function runSoloPairedMode(args: Args): Promise<void> {
  const { ws, callUuid, config, sessionId } = args;
  const role: DialRole = args.role ?? 'responder';

  const dataWs = await openDataChannel(sessionId);
  if (!dataWs) {
    console.warn(`[paired] failed to open data WS for session=${sessionId}`);
    await plivoClient.hangup(callUuid, config.accountId).catch(() => {});
    return;
  }

  const abort = new AbortController();
  ws.once('close', () => abort.abort('voice-ws-closed'));
  dataWs.once('close', () => abort.abort('data-ws-closed'));

  // Voice intro — initiator speaks before opening the data exchange; the
  // responder speaks when the peer's first message arrives (see hook below),
  // which keeps the two intros from overlapping on the bridge.
  if (role === 'initiator') {
    await speakIntro(ws, config);
  }

  let history: AgentJsonMessage[] = [];
  try {
    history = await runAgentLoop({
      dataWs,
      config,
      signal: abort.signal,
      sendOpeningHello: role === 'initiator',
      onFirstPeerMessage: role === 'responder' ? () => speakIntro(ws, config) : undefined,
    });
  } catch (err) {
    if (!abort.signal.aborted) console.warn(`[paired] loop error`, err);
  }

  // Voice goodbye — each side wraps up its own leg out loud.
  if (!abort.signal.aborted && ws.readyState === ws.OPEN) {
    await speakGoodbye(ws, config, history);
  }

  try {
    dataWs.close();
  } catch {
    /* ignore */
  }
  await plivoClient.hangup(callUuid, config.accountId).catch(() => {});
}

// ----- Voice bookends --------------------------------------------------------

async function speakIntro(ws: ServerWebSocket, config: AgentConfig): Promise<void> {
  const line = await generateLine(config, {
    instruction:
      'You just connected on a phone call with another business. ' +
      'Say your one-sentence opening line: greet them and identify yourself and your business. ' +
      'Under 15 words. Output ONLY the spoken line, no quotes.',
  });
  if (line) await speak({ ws, speakerName: config.name, text: line, voice: config.voice });
}

async function speakGoodbye(
  ws: ServerWebSocket,
  config: AgentConfig,
  history: AgentJsonMessage[],
): Promise<void> {
  const line = await generateLine(config, {
    instruction:
      'The structured negotiation below is complete. Say a one-sentence spoken farewell that ' +
      'summarizes the outcome for anyone listening on the call. Under 18 words. ' +
      'Output ONLY the spoken line, no quotes.\n\nNegotiation transcript (JSON):\n' +
      JSON.stringify(history.slice(-10)),
  });
  await speak({
    ws,
    speakerName: config.name,
    text: line || 'Thanks for the call — goodbye.',
    voice: config.voice,
  });
}

async function generateLine(
  config: AgentConfig,
  args: { instruction: string },
): Promise<string> {
  try {
    const text = await llm.respondText({
      systemPrompt: config.prompt,
      history: [],
      userText: args.instruction,
    });
    return text.trim().replace(/^"|"$/g, '');
  } catch (err) {
    console.warn(`[paired] line generation failed for ${config.name}`, err);
    return '';
  }
}

// ----- Data channel ----------------------------------------------------------

async function openDataChannel(sessionId: string): Promise<ClientWebSocket | null> {
  const { brokerWsUrl } = await import('@/lib/brokerUrl');
  const url = brokerWsUrl(`/data/${sessionId}`);
  return await new Promise((resolve) => {
    const ws = new ClientWebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(null);
    }, DATA_WS_OPEN_TIMEOUT_MS);
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

// ----- Agent JSON loop -------------------------------------------------------

/**
 * Alternating JSON exchange over the broker relay. Resolves with the full
 * message history (both sides) so the caller can voice a summary.
 */
async function runAgentLoop(args: {
  dataWs: ClientWebSocket;
  config: AgentConfig;
  signal: AbortSignal;
  sendOpeningHello: boolean;
  onFirstPeerMessage?: () => Promise<void>;
}): Promise<AgentJsonMessage[]> {
  const { dataWs, config, signal, sendOpeningHello, onFirstPeerMessage } = args;
  const history: AgentJsonMessage[] = [];

  if (sendOpeningHello) {
    const hello: AgentJsonMessage = {
      type: 'hello',
      from: config.name,
      capabilities: config.capabilities,
    };
    history.push(hello);
    publishMessage(config.name, hello);
    dataWs.send(JSON.stringify(hello));
  }

  let turns = 0;
  let sawFirstPeerMessage = false;
  await new Promise<void>((resolve) => {
    const onMessage = async (data: Buffer | string) => {
      if (signal.aborted) return;
      const raw = typeof data === 'string' ? data : data.toString();
      let peerMsg: AgentJsonMessage;
      try {
        peerMsg = JSON.parse(raw) as AgentJsonMessage;
      } catch {
        return;
      }

      if (!sawFirstPeerMessage) {
        sawFirstPeerMessage = true;
        if (onFirstPeerMessage) {
          await onFirstPeerMessage().catch(() => {});
        }
      }

      history.push(peerMsg);
      if (peerMsg.type === 'bye') {
        resolve();
        return;
      }

      if (++turns > MAX_TURNS) {
        const goodbye: AgentJsonMessage = { type: 'bye' };
        history.push(goodbye);
        dataWs.send(JSON.stringify({ ...goodbye, from: config.name }));
        publishMessage(config.name, goodbye);
        resolve();
        return;
      }

      try {
        const reply = await llm.respondJson({
          systemPrompt: config.prompt,
          history,
          peerMessage: peerMsg,
        });
        history.push(reply);
        const tagged = { ...reply, from: config.name };
        dataWs.send(JSON.stringify(tagged));
        publishMessage(config.name, reply);
        if (reply.type === 'bye' || ('done' in reply && reply.done)) {
          resolve();
        }
      } catch (err) {
        console.warn('[paired] llm error', err);
        resolve();
      }
    };

    dataWs.on('message', onMessage);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  return history;
}

function publishMessage(from: string, payload: AgentJsonMessage): void {
  eventBus.publishDemo({
    kind: 'agent.message',
    from,
    payload,
    ts: Date.now(),
  });
}
