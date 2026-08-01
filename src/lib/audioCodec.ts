/**
 * Audio codec helpers for bridging Plivo's mu-law 8kHz telephony stream and
 * OpenAI's PCM16 APIs (Whisper at 16kHz, tts-1 returning 24kHz PCM).
 *
 * Everything here is pure CPU — no external deps. Quality is "telephony", not
 * studio: resampling is linear / averaging, no anti-alias filter. Good enough
 * for an 8kHz endpoint anyway.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** ITU-T G.711 mu-law encode a single signed 16-bit PCM sample → byte. */
export function linearToMulawSample(pcm: number): number {
  let sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm = pcm + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** ITU-T G.711 mu-law decode a single byte → signed 16-bit PCM sample. */
export function mulawToLinearSample(ulaw: number): number {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Convert a mu-law byte buffer → 16-bit PCM Int16Array (host endian). */
export function mulawToPcm16(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = mulawToLinearSample(mulaw[i]);
  }
  return out;
}

/** Convert 16-bit PCM Int16Array → mu-law Buffer. */
export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = linearToMulawSample(pcm[i]);
  }
  return out;
}

/**
 * Resample Int16 PCM from `fromRate` to `toRate`. No anti-alias filter —
 * naive linear interpolation upward / averaging downward. Sufficient for
 * the 8 ↔ 16 ↔ 24 kHz hops we need.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Int16Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    out[i] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

/**
 * Parse a little-endian Int16 PCM byte stream (as returned by OpenAI TTS in
 * `pcm` format) into an Int16Array view. The buffer length must be even.
 */
export function pcmBytesToInt16(buf: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/** Wrap raw PCM16 mono into a minimal WAV file Buffer (for Whisper uploads). */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // PCM subchunk size
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm.length; i++) {
    wav.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return wav;
}

/**
 * Cheap mu-law silence detector: a frame is "silent" if every byte is close
 * to mu-law silence (0xFF or 0x7F). Returns the fraction of silent bytes.
 * Used as a tiny VAD signal — anything below ~0.85 is "speech-ish".
 */
export function silenceFraction(mulaw: Buffer): number {
  let silent = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const b = mulaw[i];
    if (b === 0xff || b === 0x7f || b === 0xfe || b === 0x7e) silent += 1;
  }
  return mulaw.length === 0 ? 1 : silent / mulaw.length;
}
