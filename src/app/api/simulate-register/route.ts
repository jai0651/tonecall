import { NextRequest, NextResponse } from 'next/server';
import { registerCall } from '@/lib/callRegistry';
import { listAgentConfigs } from '@/lib/agentConfigs';

/**
 * Dev-only counterpart to /api/simulate's federated mode.
 *
 * The initiating middleware POSTs { callUuid } here before opening a fake
 * voice WS to /voice/:callUuid on THIS middleware. We register the callUuid
 * against our (single) owned agent so voiceHandler can resolve it, and reply
 * with the agent's number. The leg gets the default responder role — same
 * as any real dialed-into leg.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { callUuid?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.callUuid) {
    return NextResponse.json({ error: 'missing_callUuid' }, { status: 400 });
  }

  const [agent] = listAgentConfigs();
  if (!agent) {
    return NextResponse.json({ error: 'no_local_agent' }, { status: 400 });
  }

  registerCall(body.callUuid, agent.number);
  console.log(`[simulate-register] call=${body.callUuid} → agent=${agent.name}@${agent.number}`);
  return NextResponse.json({ ok: true, number: agent.number });
}
