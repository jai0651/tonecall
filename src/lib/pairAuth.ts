/**
 * HMAC signing for /api/pair requests.
 *
 * The pairing endpoint is the trust boundary of AVIP: whoever presents a
 * matching (myNonce, peerNonce) pair gets joined to the session. Without
 * authentication, anyone who overhears the DTMF preamble (it's audible on
 * the call!) could POST first and steal the session.
 *
 * Scheme (AVIP-1 interim, per-deployment shared secret):
 *   signature = hex(HMAC-SHA256(secret, callUuid|myNonce|peerNonce|agentNumber|ts))
 *   - `ts` (epoch ms) must be within AVIP_PAIR_MAX_SKEW_MS of broker time,
 *     which bounds the replay window.
 *   - Every middleware in the federation shares AVIP_PAIR_SECRET.
 *
 * AVIP-3 replaces the shared secret with per-domain keys published at
 * /.well-known — same wire format, different key distribution.
 *
 * Backwards compatible: when AVIP_PAIR_SECRET is unset, requests verify as
 * ok (open pairing, the pre-AVIP-1 behaviour) and signing is a no-op.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_MAX_SKEW_MS = 30_000;

export type PairRequest = {
  callUuid: string;
  myNonce: string;
  peerNonce: string;
  agentNumber: string;
};

export type SignedPairRequest = PairRequest & { ts?: number; signature?: string };

function pairSecret(): string | undefined {
  const s = process.env.AVIP_PAIR_SECRET?.trim();
  return s ? s : undefined;
}

function maxSkewMs(): number {
  return Number(process.env.AVIP_PAIR_MAX_SKEW_MS ?? DEFAULT_MAX_SKEW_MS);
}

function computeSignature(req: PairRequest, ts: number, secret: string): string {
  const payload = `${req.callUuid}|${req.myNonce}|${req.peerNonce}|${req.agentNumber}|${ts}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Attach `ts` + `signature` to a pair request. Passthrough (unsigned) when
 * no AVIP_PAIR_SECRET is configured.
 */
export function buildSignedPairRequest(req: PairRequest, now = Date.now()): SignedPairRequest {
  const secret = pairSecret();
  if (!secret) return { ...req };
  return { ...req, ts: now, signature: computeSignature(req, now, secret) };
}

export type PairVerdict = { ok: true } | { ok: false; reason: string };

/** Verify a pair request at the broker boundary. */
export function verifyPairRequest(body: SignedPairRequest, now = Date.now()): PairVerdict {
  const secret = pairSecret();
  if (!secret) return { ok: true };

  if (typeof body.ts !== 'number' || typeof body.signature !== 'string') {
    return { ok: false, reason: 'missing_signature' };
  }
  if (Math.abs(now - body.ts) > maxSkewMs()) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = computeSignature(body, body.ts, secret);
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(body.signature, 'hex');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
