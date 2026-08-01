import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSignedPairRequest, verifyPairRequest, type PairRequest } from './pairAuth';

const REQ: PairRequest = {
  callUuid: 'call-123',
  myNonce: '11111111',
  peerNonce: '22222222',
  agentNumber: '+1AAAAAAAAAA',
};

describe('pairAuth', () => {
  beforeEach(() => {
    process.env.AVIP_PAIR_SECRET = 'test-secret';
    delete process.env.AVIP_PAIR_MAX_SKEW_MS;
  });

  afterEach(() => {
    delete process.env.AVIP_PAIR_SECRET;
    delete process.env.AVIP_PAIR_MAX_SKEW_MS;
  });

  it('signs and verifies a round-trip request', () => {
    const signed = buildSignedPairRequest(REQ);
    expect(signed.ts).toBeTypeOf('number');
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPairRequest(signed)).toEqual({ ok: true });
  });

  it('rejects a tampered nonce', () => {
    const signed = buildSignedPairRequest(REQ);
    const verdict = verifyPairRequest({ ...signed, myNonce: '99999999' });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a request signed with a different secret', () => {
    const signed = buildSignedPairRequest(REQ);
    process.env.AVIP_PAIR_SECRET = 'other-secret';
    const verdict = verifyPairRequest(signed);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp (replay outside the window)', () => {
    const now = Date.now();
    const signed = buildSignedPairRequest(REQ, now - 60_000);
    const verdict = verifyPairRequest(signed, now);
    expect(verdict).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects an unsigned request when a secret is configured', () => {
    const verdict = verifyPairRequest({ ...REQ });
    expect(verdict).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a non-hex signature', () => {
    const signed = buildSignedPairRequest(REQ);
    const verdict = verifyPairRequest({ ...signed, signature: 'not-hex-at-all' });
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('allows everything when no secret is configured (open pairing)', () => {
    delete process.env.AVIP_PAIR_SECRET;
    expect(verifyPairRequest({ ...REQ })).toEqual({ ok: true });
    const unsigned = buildSignedPairRequest(REQ);
    expect(unsigned.signature).toBeUndefined();
    expect(unsigned.ts).toBeUndefined();
  });
});
