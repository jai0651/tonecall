import { NextRequest, NextResponse } from 'next/server';
import { plivoClient } from '@/lib/plivo';

/**
 * DEBUG ONLY: inject a DTMF digit string onto a specific Plivo call via REST
 * `sendDigits`. Used to probe whether the digits arrive at the peer leg's
 * stream (i.e., whether DTMF crosses legs through the conference mix at
 * audio_track=inbound).
 *
 * Usage:
 *   curl -X POST "http://localhost:3000/api/debug-dtmf?call=<callUuid>&digits=12345"
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl;
  const callUuid = url.searchParams.get('call');
  const digits = url.searchParams.get('digits');
  if (!callUuid || !digits) {
    return NextResponse.json({ error: 'pass ?call=<uuid>&digits=<str>' }, { status: 400 });
  }
  try {
    await plivoClient.sendDigits(callUuid, digits);
    console.log(`[debug-dtmf] sent digits="${digits}" to call=${callUuid}`);
    return NextResponse.json({ ok: true, callUuid, digits });
  } catch (err) {
    return NextResponse.json(
      { error: 'sendDigits_failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ usage: 'POST ?call=<uuid>&digits=<str>' });
}
