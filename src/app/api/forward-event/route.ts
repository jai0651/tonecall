import { NextRequest, NextResponse } from 'next/server';
import { eventBus } from '@/lib/eventBus';
import type { DemoEvent } from '@/types';

/**
 * Receive a federated DemoEvent from a follower middleware and re-emit it on
 * THIS middleware's local bus. The dashboard's SSE stream picks it up like
 * any local event.
 *
 * To avoid forwarding loops, we use `publishLocal` (not `publishDemo`) —
 * received events are never re-forwarded out.
 *
 * No auth on this endpoint right now — the federation is trusted-network
 * only (both middlewares run on the same operator's infrastructure).
 * Production would add an HMAC header.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let event: DemoEvent;
  try {
    event = (await req.json()) as DemoEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!event || typeof event !== 'object' || !('kind' in event)) {
    return NextResponse.json({ error: 'malformed_event' }, { status: 400 });
  }

  eventBus.publishLocal(event);
  return NextResponse.json({ ok: true });
}
