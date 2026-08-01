import { NextRequest, NextResponse } from 'next/server';

/**
 * Plivo Stream status callback. Plivo POSTs here when stream lifecycle events
 * occur (start, error, end). Use this to diagnose stream connection issues.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const form = await req.formData();
    const payload: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      payload[k] = String(v);
    }
    console.log('[stream-status]', JSON.stringify(payload));
  } catch (err) {
    console.warn('[stream-status] parse error', err);
  }
  return new NextResponse(null, { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 200 });
}
