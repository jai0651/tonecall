/**
 * Streaming TTS.
 *
 * Stub variant: emits ~1s of mu-law silence so the pipeline plays "something".
 *
 * Real variant: OpenAI `tts-1` with `response_format: 'pcm'`. That returns raw
 * mono 16-bit little-endian PCM at 24kHz; we downsample to 8kHz and mu-law
 * encode for Plivo. First-byte latency for tts-1 is typically ~300-600ms — not
 * truly streaming, but workable. For lower latency / true streaming, swap to
 * OpenAI Realtime API's TTS (audio.delta events).
 *
 * Recording: set RECORD_AUDIO=true to dump each utterance to
 *   ./tonecall_audio/<ts>_<speaker>_<seq>.wav (24kHz PCM16)
 * so you can `afplay` it locally and verify voices.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { getOpenAI } from './openaiClient';
import { pcmBytesToInt16, resamplePcm16, pcm16ToMulaw, pcm16ToWav } from './audioCodec';

const USE_STUBS = (process.env.USE_STUBS ?? 'true') === 'true';
const RECORD_AUDIO = (process.env.RECORD_AUDIO ?? 'false') === 'true';
const RECORD_DIR = process.env.RECORD_AUDIO_DIR ?? './tonecall_audio';
// When true, the server-process machine also plays each utterance through
// its own audio output (via `afplay` on macOS, `aplay`/`paplay` on Linux).
// Lets you HEAR the agents talking through your laptop speakers in real
// time instead of just over the phone leg.
const PLAY_LOCAL = (process.env.PLAY_LOCAL ?? 'false') === 'true';
const PLAY_LOCAL_CMD = process.env.PLAY_LOCAL_CMD ?? (process.platform === 'darwin' ? 'afplay' : 'aplay');

export interface TtsResult {
  audio: Buffer; // mu-law 8kHz
}

export type TtsArgs = {
  text: string;
  voice?: string;
  /** Speaker label for the saved filename — agent name, "caller", etc. */
  speakerLabel?: string;
};

export interface TtsClient {
  synthesize(args: TtsArgs | string): Promise<TtsResult>;
}

function normalizeArgs(args: TtsArgs | string): TtsArgs {
  return typeof args === 'string' ? { text: args } : args;
}

class StubTts implements TtsClient {
  async synthesize(input: TtsArgs | string): Promise<TtsResult> {
    const { text } = normalizeArgs(input);
    const length = 8000; // 1s @ 8kHz
    const audio = Buffer.alloc(length, 0xff);
    for (let i = 0; i < text.length && i * 200 < length; i++) {
      audio[i * 200] = (i % 256) as number;
    }
    return { audio };
  }
}

let recordSeq = 0;
function recordPcmAsWav(pcm24k: Int16Array, speakerLabel: string): string | null {
  // Always write to disk if either recording is on OR local playback is on
  // (we need a file on disk to feed to `afplay`). Returns the path or null.
  if (!RECORD_AUDIO && !PLAY_LOCAL) return null;
  try {
    mkdirSync(RECORD_DIR, { recursive: true });
    recordSeq += 1;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = (speakerLabel || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = join(RECORD_DIR, `${ts}_${safe}_${String(recordSeq).padStart(3, '0')}.wav`);
    const wav = pcm16ToWav(pcm24k, 24000);
    writeFileSync(file, wav);
    if (RECORD_AUDIO) console.log(`[tts:record] saved ${file} (${pcm24k.length} samples)`);
    return file;
  } catch (err) {
    console.warn('[tts:record] save failed', err);
    return null;
  }
}

function playLocally(filePath: string): void {
  if (!PLAY_LOCAL || !filePath) return;
  try {
    // Spawn detached + ignore stdio so it doesn't block the orchestrator.
    // The next utterance comes after our caller has slept for the audio
    // duration anyway, so we don't need to await.
    const child = spawn(PLAY_LOCAL_CMD, [filePath], { stdio: 'ignore', detached: true });
    child.on('error', (err) =>
      console.warn(`[tts:play] ${PLAY_LOCAL_CMD} failed: ${err.message}`),
    );
    child.unref();
    console.log(`[tts:play] ${PLAY_LOCAL_CMD} ${filePath}`);
  } catch (err) {
    console.warn('[tts:play] spawn failed', err);
  }
}

class OpenAiTts implements TtsClient {
  async synthesize(input: TtsArgs | string): Promise<TtsResult> {
    const { text, voice, speakerLabel } = normalizeArgs(input);
    if (!text || !text.trim()) {
      return { audio: Buffer.alloc(0) };
    }
    const resolvedVoice = (voice ?? process.env.OPENAI_TTS_VOICE ?? 'alloy') as any;
    try {
      const openai = getOpenAI();
      const resp = await openai.audio.speech.create({
        model: process.env.OPENAI_TTS_MODEL ?? 'tts-1',
        voice: resolvedVoice,
        input: text,
        response_format: 'pcm', // 24kHz mono PCM16 little-endian
      });
      const arrayBuf = await resp.arrayBuffer();
      const pcm24k = pcmBytesToInt16(Buffer.from(arrayBuf));
      const wavPath = recordPcmAsWav(pcm24k, `${speakerLabel ?? 'agent'}_${resolvedVoice}`);
      if (wavPath) playLocally(wavPath);
      const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
      const mulaw = pcm16ToMulaw(pcm8k);
      return { audio: mulaw };
    } catch (err) {
      console.warn('[tts] openai synthesis failed', err);
      return { audio: Buffer.alloc(0) };
    }
  }
}

export const tts: TtsClient = USE_STUBS ? new StubTts() : new OpenAiTts();
