import { NextRequest, NextResponse } from 'next/server';
import { plivoClient } from '@/lib/plivo';
import { eventBus } from '@/lib/eventBus';
import { getAgentConfig, listAgentConfigs } from '@/lib/agentConfigs';
import { setPendingDial } from '@/lib/dialRegistry';

/**
 * Demo trigger — AVIP-1 Dial-bridge topology.
 *
 * Originates ONE call to the local agent's DID (numberA). When that DID's
 * Application answer URL fires, /api/answer finds the pending dial stashed
 * here and returns <Stream> + <Dial numberB>. Plivo bridges the two legs
 * over real PSTN/SIP, so audio AND DTMF cross end-to-end — the in-band
 * nonce handshake (stateMachine.ts) does the pairing, with no shared
 * middleware state required.
 *
 * This one shape covers both deployments:
 *   - single middleware: both DIDs' Applications point at this process; it
 *     sees both webhooks and both voice streams.
 *   - federated (the default demo): this middleware owns only numberA;
 *     numberB's Application points at the peer middleware. The peer needs
 *     NO advance notice — its DID just receives an inbound call and
 *     listens for the DTMF preamble like it would for any caller.
 *
 * History: earlier revisions used <Conference> because a bare same-account
 * <Dial> hit Ring Timeout — the dialed DID's Application returned
 * <Conference> XML, which broke the bridge. With /api/answer returning
 * <Stream>+<Wait> on the callee leg the Dial bridges cleanly (verified by
 * the dial-dtmf probe: all preamble digits crossed leg-to-leg).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { numberA?: string; numberB?: string; callerId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body */
  }

  const configs = listAgentConfigs();
  const numberA = body.numberA ?? configs[0]?.number ?? process.env.PLIVO_NUMBER_A!;
  const numberB = body.numberB ?? process.env.PLIVO_NUMBER_B!;
  const callerId = body.callerId ?? process.env.PLIVO_CALLER_ID ?? numberA;

  if (!numberA || !numberB) {
    return NextResponse.json({ error: 'numbers_unconfigured' }, { status: 400 });
  }
  // The originating agent must live on THIS middleware: /api/answer here
  // has to see the webhook to claim the dial and run the initiator leg.
  if (!getAgentConfig(numberA)) {
    return NextResponse.json(
      {
        error: 'numberA_not_owned',
        detail: `this middleware owns [${configs.map((c) => c.number).join(', ')}]; trigger from the middleware that owns ${numberA}`,
      },
      { status: 400 },
    );
  }

  const publicHost = (process.env.PUBLIC_HOST ?? `localhost:${process.env.PORT ?? 3000}`)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const scheme = publicHost.startsWith('localhost') ? 'http' : 'https';
  // Plivo ignores this answer_url when the destination is a same-account DID
  // with an Application attached (the Application's URL wins) — passed anyway
  // for the non-Application case.
  const answerUrl = `${scheme}://${publicHost}/api/answer`;

  // When numberA's answer webhook lands, Dial out to numberB.
  setPendingDial(numberA, numberB);

  eventBus.publishDemo({
    kind: 'call.triggered',
    callerNumber: numberA,
    calleeNumber: numberB,
    ts: Date.now(),
  });

  try {
    const leg = await plivoClient.originate({
      from: callerId,
      to: numberA,
      answerUrl,
      accountId: '1',
    });
    return NextResponse.json({
      ok: true,
      mode: 'dial_bridge',
      originator: { to: numberA, dialTarget: numberB, requestUuid: leg.requestUuid },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'originate_failed', detail: (err as Error).message },
      { status: 502 },
    );
  }
}
