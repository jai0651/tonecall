import { NextRequest, NextResponse } from 'next/server';

/**
 * Plivo hangup URL. We don't act on hangup events at the HTTP layer (cleanup
 * happens in the voice WS lifecycle), but we accept the POST so Plivo doesn't
 * log webhook errors.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Best-effort log so the live demo can see hangup reasons.
  try {
    const form = await req.formData();
    const callUuid = form.get('CallUUID');
    const cause = form.get('HangupCause') ?? form.get('HangupCauseName');
    console.log(`[plivo] hangup call=${callUuid} cause=${cause}`);
  } catch {
    /* ignore */
  }
  return new NextResponse(null, { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 200 });
}
