/**
 * speak() — synthesise `text` with TTS, ship the mu-law audio into a Plivo
 * leg via `playAudio` events, publish a transcript event for the dashboard,
 * and block for the audio's playback duration so callers can compose turns
 * sequentially.
 *
 * We chunk the TTS audio into ~200ms playAudio frames so Plivo's queue
 * doesn't choke on a single multi-second blob and so playback feels
 * responsive (later turns can be queued while earlier ones drain).
 */

import type { WebSocket as ServerWebSocket } from 'ws';
import { tts } from '@/lib/tts';
import { eventBus } from '@/lib/eventBus';
import {
  playAudioFrame,
  PLIVO_MULAW_SAMPLE_RATE,
} from '@/lib/audio';

const CHUNK_BYTES = 1600; // 200ms @ 8kHz mu-law — comfortable for Plivo's queue

export type SpeakArgs = {
  ws: ServerWebSocket;
  speakerName: string;
  text: string;
  /** OpenAI TTS voice id — overrides the env default. */
  voice?: string;
  /** If true, block until the audio finishes playing (default true). */
  waitForDuration?: boolean;
  /** Extra ms of buffer after computed duration before resolving. */
  tailMs?: number;
};

export async function speak(args: SpeakArgs): Promise<void> {
  const { ws, speakerName, text, voice } = args;
  const waitForDuration = args.waitForDuration ?? true;
  const tailMs = args.tailMs ?? 150;

  // Publish the transcript line FIRST so the dashboard sees it before audio
  // playback starts (better UX than waiting for synthesis).
  eventBus.publishDemo({
    kind: 'voice.transcript',
    speaker: speakerName,
    text,
    ts: Date.now(),
  });

  let audio: Buffer;
  try {
    const result = await tts.synthesize({ text, voice, speakerLabel: speakerName });
    audio = result.audio;
  } catch (err) {
    console.warn(`[speak] tts failed for "${text.slice(0, 40)}…"`, err);
    return;
  }

  if (audio.length === 0) return;
  if (ws.readyState !== ws.OPEN) return;

  // Chunked send. We don't pace at 20ms (the actual frame rate) — Plivo
  // queues; pacing only matters if we expect to be interrupted mid-stream.
  for (let i = 0; i < audio.length; i += CHUNK_BYTES) {
    if (ws.readyState !== ws.OPEN) return;
    const chunk = audio.subarray(i, i + CHUNK_BYTES);
    try {
      ws.send(playAudioFrame(chunk));
    } catch {
      return;
    }
  }

  if (waitForDuration) {
    const durationMs = Math.ceil((audio.length / PLIVO_MULAW_SAMPLE_RATE) * 1000) + tailMs;
    await sleep(durationMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
