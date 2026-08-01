import { NextRequest, NextResponse } from 'next/server';
import { registerCall } from '@/lib/callRegistry';
import { getAgentConfig } from '@/lib/agentConfigs';
import { claimDialTarget } from '@/lib/dialRegistry';
import { buildAnswerXml } from '@/lib/answerXml';

/**
 * Plivo answer URL — AVIP-1 Dial-bridge topology. Fired for every leg that
 * lands on one of our agent DIDs:
 *
 *   - The leg /api/trigger-call originated (this middleware stashed a
 *     pending dial for the DID): respond <Stream> + <Dial peer>. This is
 *     the handshake INITIATOR leg.
 *   - The peer DID being dialed into, or a human calling one of our
 *     numbers: respond <Stream> + <Wait>. This is a RESPONDER leg — the
 *     state machine listens for a DTMF preamble and falls through to
 *     human voice mode if none arrives.
 *
 * No <Conference>: the Dial bridge carries audio + DTMF leg-to-leg, which
 * is what makes the in-band nonce handshake work on real calls.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const callUuid = String(form.get('CallUUID') ?? '');
  const toRaw = String(form.get('To') ?? '');
  const fromRaw = String(form.get('From') ?? '');
  const to = normalizeNumber(toRaw);
  const from = normalizeNumber(fromRaw);

  if (!callUuid) return new NextResponse('CallUUID missing', { status: 400 });
  if (!to && !from) return new NextResponse('To or From missing', { status: 400 });

  // Find which of {To, From} is one of OUR agent DIDs:
  //   - Inbound call to our DID: To = agent number, From = external caller
  //   - Outbound call from our DID: From = agent number, To = external destination
  // The same /api/answer must work for both directions.
  let agentNumber = '';
  let config = getAgentConfig(to);
  if (config) {
    agentNumber = to;
  } else {
    config = getAgentConfig(from);
    if (config) agentNumber = from;
  }
  if (!config || !agentNumber) {
    return new NextResponse(
      `No agent configured for either side: to=${toRaw} from=${fromRaw}`,
      { status: 404 },
    );
  }

  registerCall(callUuid, agentNumber);

  const publicHost = (process.env.PUBLIC_HOST ?? `localhost:${process.env.PORT ?? 3000}`)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const wsScheme = publicHost.startsWith('localhost') ? 'ws' : 'wss';
  const streamUrl = `${wsScheme}://${publicHost}/voice/${callUuid}`;

  // Claim-by-callUuid: a webhook retry for the same call gets the same XML;
  // a twin call_uuid for the same number can never trigger a second <Dial>.
  const dialTarget = claimDialTarget(agentNumber, callUuid);
  const role = dialTarget ? 'dial_originator' : 'callee';

  console.log(
    `[answer] callUuid=${callUuid} from=${fromRaw} to=${toRaw} ` +
      `agent=${config.name}@${agentNumber} role=${role}` +
      (dialTarget ? ` dialTo=${dialTarget}` : ''),
  );

  const xml = buildAnswerXml({
    role,
    streamUrl,
    dialTo: dialTarget ?? undefined,
    dialCallerId: agentNumber,
  });

  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml' },
  });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse(
    JSON.stringify({ status: 'ok', message: 'tonecall answer URL. Use POST with Plivo webhook params.' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function normalizeNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  if (/^\d+$/.test(trimmed)) return '+' + trimmed;
  return trimmed;
}
