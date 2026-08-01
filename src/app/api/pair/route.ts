import { NextRequest, NextResponse } from 'next/server';
import { requestPairing } from '@/ws/broker';
import { verifyPairRequest, type SignedPairRequest } from '@/lib/pairAuth';

/**
 * Broker pairing endpoint.
 *
 * Each side of a handshake POSTs here with their (callUuid, myNonce, peerNonce,
 * agentNumber). The broker waits for the matching POST from the other side and
 * returns a shared session_id. Both sides then connect to /data/<sessionId>.
 *
 * When AVIP_PAIR_SECRET is set, requests must carry a fresh HMAC signature
 * (see src/lib/pairAuth.ts) — otherwise anyone who overheard the audible
 * DTMF preamble could race the legitimate agent and steal the session.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Partial<SignedPairRequest>;

  try {
    body = (await req.json()) as Partial<SignedPairRequest>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { callUuid, myNonce, peerNonce, agentNumber } = body;
  if (!callUuid || !myNonce || !peerNonce || !agentNumber) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  const verdict = verifyPairRequest(body as SignedPairRequest);
  if (!verdict.ok) {
    console.warn(`[pair] rejected unsigned/invalid request call=${callUuid}: ${verdict.reason}`);
    return NextResponse.json({ error: 'unauthorized', reason: verdict.reason }, { status: 401 });
  }

  try {
    const sessionId = await requestPairing({ callUuid, myNonce, peerNonce, agentNumber });
    return NextResponse.json({ sessionId });
  } catch (err) {
    return NextResponse.json(
      { error: 'pair_failed', detail: (err as Error).message },
      { status: 504 },
    );
  }
}
