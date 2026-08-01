/**
 * Plivo Audio Streaming frame helpers.
 *
 * Plivo sends inbound audio as:
 *   {"event":"media","streamId":"...","media":{"payload":"<base64 mu-law>"}}
 *
 * We send audio back as `playAudio` per the SDK's wire protocol:
 *   {"event":"playAudio","media":{"contentType":"audio/x-mulaw","sampleRate":8000,"payload":"<base64>"}}
 *
 * DTMF can be played onto the call by emitting `sendDTMF` on the same WS
 * instead of using the REST sendDigits API — same effect, ~0ms RTT.
 */

import type { WebSocket } from 'ws';

export const FRAME_BYTES = 160; // 20ms @ 8kHz mu-law
export const FRAME_DURATION_MS = 20;

export const PLIVO_MULAW_CONTENT_TYPE = 'audio/x-mulaw';
export const PLIVO_MULAW_SAMPLE_RATE = 8000;

/** Build a single `playAudio` JSON frame from a raw mu-law buffer. */
export function playAudioFrame(mulaw: Buffer): string {
  return JSON.stringify({
    event: 'playAudio',
    media: {
      contentType: PLIVO_MULAW_CONTENT_TYPE,
      sampleRate: PLIVO_MULAW_SAMPLE_RATE,
      payload: mulaw.toString('base64'),
    },
  });
}

/** Decode the base64 payload of an inbound `media` event into raw mu-law bytes. */
export function decodeFrame(payload: string): Buffer {
  return Buffer.from(payload, 'base64');
}

/**
 * Iterate `buffer` in 20ms frames, yielding each as a playAudio JSON string.
 * Pads the final frame with mu-law silence (0xFF) so timing stays clean.
 */
export function* chunkToFrames(buffer: Buffer): Generator<string> {
  for (let i = 0; i < buffer.length; i += FRAME_BYTES) {
    let chunk = buffer.subarray(i, i + FRAME_BYTES);
    if (chunk.length < FRAME_BYTES) {
      const padded = Buffer.alloc(FRAME_BYTES, 0xff);
      chunk.copy(padded);
      chunk = padded;
    }
    yield playAudioFrame(chunk);
  }
}

/**
 * Generate a stylized "modem chirp" mu-law pattern — alternating low/high
 * mu-law-encoded values so humans listening hear "data is flowing."
 *
 * Cosmetic only; not meant to be acoustically a real modem.
 */
export function modemChirpFrame(seed: number): string {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) {
    buf[i] = (seed + i) % 2 === 0 ? 0x55 : 0xaa;
  }
  return playAudioFrame(buf);
}

export function silenceFrame(): string {
  return playAudioFrame(Buffer.alloc(FRAME_BYTES, 0xff));
}

/**
 * Send a DTMF burst to the caller via the open Plivo Stream WS. Plivo will
 * synthesize the DTMF tones onto the call leg's outbound audio, and the bridged
 * peer leg will receive them as inbound `dtmf` events on its own stream WS.
 *
 * This replaces the REST `client.calls.sendDigits` call (which adds 200–500ms
 * of HTTP round-trip per send) for handshake preambles.
 */
export function sendDtmfOverStream(ws: WebSocket, digits: string): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event: 'sendDTMF', dtmf: digits }));
}

/** Optional helpers exposed for callers that want raw outbound control. */
export function clearAudioFrame(streamId?: string): string {
  return JSON.stringify({ event: 'clearAudio', ...(streamId ? { streamId } : {}) });
}

export function checkpointFrame(name: string, streamId?: string): string {
  return JSON.stringify({
    event: 'checkpoint',
    name,
    ...(streamId ? { streamId } : {}),
  });
}
