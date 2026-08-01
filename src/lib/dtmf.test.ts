import { describe, expect, it } from 'vitest';
import { buildPreamble, generateNonce, PreambleDetector } from './dtmf';

describe('dtmf preamble', () => {
  it('generateNonce returns 8 zero-padded digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateNonce()).toMatch(/^\d{8}$/);
    }
  });

  it('buildPreamble wraps the nonce in prefix and suffix', () => {
    expect(buildPreamble('12345678')).toBe('909012345678#');
  });

  it('detects a preamble fed digit-by-digit', () => {
    const d = new PreambleDetector();
    const preamble = buildPreamble('00112233');
    let detected: string | null = null;
    for (const digit of preamble) {
      detected = d.feed(digit) ?? detected;
    }
    expect(detected).toBe('00112233');
  });

  it('detects a preamble surrounded by garbage digits', () => {
    const d = new PreambleDetector();
    let detected: string | null = null;
    for (const digit of `55${buildPreamble('87654321')}77`) {
      detected = d.feed(digit) ?? detected;
    }
    expect(detected).toBe('87654321');
  });

  it('does not fire on random keypresses without the grammar', () => {
    const d = new PreambleDetector();
    for (const digit of '123456789012345678901234') {
      expect(d.feed(digit)).toBeNull();
    }
  });

  it('resets after a detection so a repeated preamble is detected again', () => {
    const d = new PreambleDetector();
    const preamble = buildPreamble('13571357');
    let hits = 0;
    for (const digit of preamble + preamble) {
      if (d.feed(digit)) hits++;
    }
    expect(hits).toBe(2);
  });

  it('keeps its buffer bounded under a digit flood', () => {
    const d = new PreambleDetector();
    for (let i = 0; i < 1000; i++) d.feed('5');
    // Still detects a fresh preamble after the flood.
    let detected: string | null = null;
    for (const digit of buildPreamble('24682468')) {
      detected = d.feed(digit) ?? detected;
    }
    expect(detected).toBe('24682468');
  });
});
