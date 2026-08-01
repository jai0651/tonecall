/**
 * VOICE mode: caller is human. Run the standard STT → LLM → TTS loop on the
 * voice WebSocket.
 *
 * Used when the handshake times out (no peer agent detected on the other end).
 */

import type { WebSocket } from 'ws';
import type { AgentConfig } from '@/types';
import { llm } from '@/lib/llm';
import { openStt } from '@/lib/stt';
import { tts } from '@/lib/tts';
import { chunkToFrames, decodeFrame, FRAME_DURATION_MS } from '@/lib/audio';
import { plivoClient } from '@/lib/plivo';
import { parsePlivoEvent } from './voiceHandler';
import { eventBus } from '@/lib/eventBus';

type Args = {
  ws: WebSocket;
  callUuid: string;
  config: AgentConfig;
};

export async function runVoiceMode({ ws, callUuid, config }: Args): Promise<void> {
  const stt = openStt();
  const history: { role: 'user' | 'assistant'; text: string }[] = [];

  const phaseStartedAt = Date.now();
  let turns = 0;
  eventBus.publishDemo({ kind: 'phase.started', phase: 'human_voice', ts: phaseStartedAt });

  // Greet first so the human knows the line is live.
  const greeting =
    config.name === 'vegetable_vendor'
      ? "Hi, this is Anil from Mumbai Fresh Produce. What can I get you?"
      : config.name === 'pizza_shop'
        ? 'Hi, this is Bella Pizza. What can I help with?'
        : `Hi, this is ${config.name.replace(/_/g, ' ')}. How can I help?`;
  await speak(ws, greeting, config.name, config.voice);
  turns += 1;

  const abort = new AbortController();
  ws.once('close', () => abort.abort('voice-ws-closed'));

  await new Promise<void>((resolve) => {
    const onMessage = async (data: Buffer | string) => {
      if (abort.signal.aborted) return;
      const raw = typeof data === 'string' ? data : data.toString();
      const event = parsePlivoEvent(raw);
      if (!event) return;

      if (event.event === 'stop') {
        resolve();
        return;
      }
      if (event.event !== 'media') return;

      const audio = decodeFrame(event.media.payload);
      const transcript = await stt.feed(audio);
      if (!transcript) return;

      eventBus.publishDemo({
        kind: 'voice.transcript',
        speaker: 'caller',
        text: transcript,
        ts: Date.now(),
      });
      history.push({ role: 'user', text: transcript });
      turns += 1;

      try {
        const reply = await llm.respondText({
          systemPrompt: config.prompt,
          history,
          userText: transcript,
        });
        history.push({ role: 'assistant', text: reply });
        await speak(ws, reply, config.name, config.voice);
        turns += 1;
      } catch (err) {
        console.warn('[voice] llm error', err);
      }
    };

    ws.on('message', onMessage);
    abort.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  await stt.close();
  const phaseEndedAt = Date.now();
  eventBus.publishDemo({
    kind: 'phase.ended',
    phase: 'human_voice',
    durationMs: phaseEndedAt - phaseStartedAt,
    turns,
    ts: phaseEndedAt,
  });
  await plivoClient.hangup(callUuid, config.accountId).catch(() => {});
}

async function speak(
  ws: WebSocket,
  text: string,
  speakerName: string,
  voice?: string,
): Promise<void> {
  eventBus.publishDemo({
    kind: 'voice.transcript',
    speaker: speakerName,
    text,
    ts: Date.now(),
  });
  const { audio } = await tts.synthesize({ text, voice, speakerLabel: speakerName });
  for (const frame of chunkToFrames(audio)) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(frame);
    await sleep(FRAME_DURATION_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
