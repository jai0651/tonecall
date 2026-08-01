/**
 * Streaming STT.
 *
 * Stub variant: emits canned phrases every ~2s of buffered audio so the demo
 * pipeline runs end-to-end without an API key.
 *
 * Real variant: buffers mu-law 8kHz frames until ~1.4s of speech + ~500ms of
 * trailing silence is seen, then resamples to 16kHz PCM, wraps as WAV, and
 * sends to OpenAI's `whisper-1` /audio/transcriptions. Returns the transcript
 * (or null if the buffer was effectively silent).
 *
 * Note: this is not "true streaming" — Whisper is a batch API. For real-time
 * turn-taking with barge-in, swap to OpenAI Realtime API (PCM16 over WS).
 * Batch-chunked is fine for the tonecall voice-fallback path, which exists
 * specifically to demonstrate the slow path.
 */

import { Readable } from 'stream';
import { toFile } from 'openai';
import { getOpenAI } from './openaiClient';
import { mulawToPcm16, resamplePcm16, pcm16ToWav, silenceFraction } from './audioCodec';

const USE_STUBS = (process.env.USE_STUBS ?? 'true') === 'true';

export interface SttStream {
  feed(chunk: Buffer): Promise<string | null>;
  close(): Promise<void>;
}

// ---------- Stub ------------------------------------------------------------

const STUB_THRESHOLD_BYTES = 16_000; // ~2s of 8kHz mu-law

class StubSttStream implements SttStream {
  private buffered = 0;
  private samples = [
    'hello, I want to place an order',
    'I would like two large pizzas with mushrooms please',
    'how long until delivery?',
    'thanks, please confirm the total',
  ];
  private cursor = 0;

  async feed(chunk: Buffer): Promise<string | null> {
    this.buffered += chunk.length;
    if (this.buffered < STUB_THRESHOLD_BYTES) return null;
    this.buffered = 0;
    const next = this.samples[this.cursor % this.samples.length];
    this.cursor++;
    return next;
  }
  async close(): Promise<void> {
    /* nothing */
  }
}

// ---------- Real (OpenAI Whisper) -------------------------------------------

// 8kHz mu-law: 1 byte per sample, 8000 bytes/s.
// We endpoint utterances by:
//   - require >= MIN_SPEECH_BYTES of buffered audio AND
//   - the trailing TRAILING_SILENCE_MS to be mostly silent, OR
//   - the buffer to exceed MAX_BUFFER_BYTES (~6s) — flush regardless.
const MIN_SPEECH_BYTES = 8_000; // ~1.0s
const MAX_BUFFER_BYTES = 48_000; // ~6.0s safety cap
const TRAILING_SILENCE_MS = 500;
const SILENCE_FRACTION_THRESHOLD = 0.85;

class OpenAiSttStream implements SttStream {
  private buf: Buffer = Buffer.alloc(0);
  // Track silence fraction of the most recent ~500ms of audio.
  private trailing: Buffer[] = [];
  private trailingBytes = 0;
  private inFlight: Promise<string | null> | null = null;

  async feed(chunk: Buffer): Promise<string | null> {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    this.trailing.push(chunk);
    this.trailingBytes += chunk.length;
    const trailingBudget = Math.floor((TRAILING_SILENCE_MS / 1000) * 8000);
    while (this.trailingBytes > trailingBudget && this.trailing.length > 1) {
      const dropped = this.trailing.shift()!;
      this.trailingBytes -= dropped.length;
    }

    const ready =
      this.buf.length >= MAX_BUFFER_BYTES ||
      (this.buf.length >= MIN_SPEECH_BYTES &&
        this.trailingBytes >= trailingBudget &&
        silenceFraction(Buffer.concat(this.trailing)) >= SILENCE_FRACTION_THRESHOLD);

    if (!ready || this.inFlight) return null;

    const utterance = this.buf;
    this.buf = Buffer.alloc(0);
    this.trailing = [];
    this.trailingBytes = 0;

    this.inFlight = this.transcribe(utterance).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async close(): Promise<void> {
    /* nothing — caller drops the reference */
  }

  private async transcribe(mulaw: Buffer): Promise<string | null> {
    // Skip if the whole utterance is mostly silent — Whisper costs money.
    if (silenceFraction(mulaw) >= 0.97) return null;

    const pcm8k = mulawToPcm16(mulaw);
    const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
    const wav = pcm16ToWav(pcm16k, 16000);

    try {
      const openai = getOpenAI();
      const file = await toFile(Readable.from(wav), 'utterance.wav', {
        type: 'audio/wav',
      });
      const result = await openai.audio.transcriptions.create({
        model: process.env.OPENAI_STT_MODEL ?? 'whisper-1',
        file,
        response_format: 'text',
      });
      const text = typeof result === 'string' ? result : (result as any).text ?? '';
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      console.warn('[stt] openai transcription failed', err);
      return null;
    }
  }
}

export function openStt(): SttStream {
  return USE_STUBS ? new StubSttStream() : new OpenAiSttStream();
}
