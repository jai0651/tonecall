/**
 * AVIP-0 handshake preamble grammar:  `9090<8 digits>#`
 *
 *   9090       — protocol-version-0 magic prefix (digits, not `*` — Plivo's
 *                DTMF detector drops `*` more often than digits)
 *   8 digits   — random nonce identifying this side
 *   #          — end marker (also a digit-keypad symbol but reliably detected
 *                across PSTN equipment)
 *
 * 13 DTMF symbols. With 200ms tones + 100ms gaps that's ~3.9s played.
 * Humans never punch `9090` first thing on a call — collision-safe in
 * practice.
 */

export const PREAMBLE_PREFIX = '9090';
export const PREAMBLE_SUFFIX = '#';

const PATTERN = /9090(\d{8})#/;

export function generateNonce(): string {
  // 8 digits, zero-padded. Math.random is fine — these are proof-of-
  // co-presence, not secrets. HMAC at the broker hardens identity.
  const n = Math.floor(Math.random() * 100_000_000);
  return n.toString().padStart(8, '0');
}

export function buildPreamble(nonce: string): string {
  return `${PREAMBLE_PREFIX}${nonce}${PREAMBLE_SUFFIX}`;
}

export class PreambleDetector {
  private buffer = '';

  /** Returns the peer nonce once a full preamble has been seen, else null. */
  feed(digit: string): string | null {
    this.buffer += digit;
    // Keep the buffer bounded — a preamble is 13 chars; 64 covers two
    // overlapping bursts (in case Plivo's detector emits a tone twice).
    if (this.buffer.length > 64) {
      this.buffer = this.buffer.slice(-64);
    }
    const match = PATTERN.exec(this.buffer);
    if (match) {
      this.buffer = '';
      return match[1];
    }
    return null;
  }

  reset(): void {
    this.buffer = '';
  }
}
