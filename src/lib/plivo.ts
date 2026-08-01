/**
 * Plivo REST API wrapper — multi-account.
 *
 * The cross-vendor demo runs on TWO Plivo accounts under one middleware:
 *   - Account 1 owns NUMBER_A (vegetable_vendor)
 *   - Account 2 owns NUMBER_B (pizza_shop)
 *
 * Each REST call (originate, hangup, sendDigits, startStream) must be
 * authenticated against the account that OWNS the call's `to` / call_uuid.
 * Callers pass the agent number along; this wrapper picks the right creds.
 *
 * For the audio-stream WS interactions (DTMF in/out, audio playback) we go
 * directly over the open Stream WebSocket — see `src/lib/audio.ts`.
 */

import { accountForNumber } from './agentConfigs';

const USE_STUBS = (process.env.USE_STUBS ?? 'true') === 'true';

type Account = { id: string; token: string };

function account(id: '1' | '2' | undefined): Account {
  const slot = id ?? '1';
  if (slot === '2') {
    const id2 = process.env.PLIVO_AUTH_ID_2;
    const tok2 = process.env.PLIVO_AUTH_TOKEN_2;
    if (!id2 || !tok2) {
      throw new Error(
        'PLIVO_AUTH_ID_2 and PLIVO_AUTH_TOKEN_2 must be set to use Account 2',
      );
    }
    return { id: id2, token: tok2 };
  }
  const id1 = process.env.PLIVO_AUTH_ID;
  const tok1 = process.env.PLIVO_AUTH_TOKEN;
  if (!id1 || !tok1) {
    throw new Error('PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN must be set');
  }
  return { id: id1, token: tok1 };
}

/** Look up the account that owns a given phone number. */
export function accountForCallNumber(number: string | undefined): '1' | '2' | undefined {
  return number ? accountForNumber(number) : undefined;
}

export interface PlivoCallClient {
  /**
   * Hang up a live call. Pass `accountId` so we route to the right Plivo
   * account; falls back to Account 1 if omitted.
   */
  hangup(callUuid: string, accountId?: '1' | '2'): Promise<void>;
  originate(args: {
    from: string;
    to: string;
    answerUrl: string;
    accountId?: '1' | '2';
  }): Promise<{ requestUuid: string }>;
  /**
   * Send DTMF onto a call leg via Plivo REST. Empirically the digits land
   * only on the originating leg's stream (Plivo does not relay them
   * cross-leg in a Conference mixer). Kept for the debug endpoint
   * /api/debug-dtmf; AVIP-0's nonce path uses Plivo's `sendDTMF` WebSocket
   * event instead, which has the same shape but ~0ms RTT.
   */
  sendDigits(callUuid: string, digits: string, accountId?: '1' | '2'): Promise<void>;

  /**
   * Start an audio stream on a live call. Plivo opens a WS to `serviceUrl`
   * and pumps mu-law audio.
   *
   * Defaults to `bidirectional=true, audioTrack=inbound` (the only combo
   * Plivo allows together). Pass `bidirectional=false` with another
   * `audioTrack` value to start an "observer" stream that hears more of
   * the call's audio path — typically used to catch peer DTMF arriving
   * via a Dial bridge.
   */
  startStream(args: {
    callUuid: string;
    serviceUrl: string;
    accountId?: '1' | '2';
    bidirectional?: boolean;
    audioTrack?: 'inbound' | 'outbound' | 'both';
  }): Promise<{ streamId?: string }>;
}

// ---- Stub (USE_STUBS=true) ------------------------------------------------

class StubPlivoClient implements PlivoCallClient {
  async hangup(callUuid: string): Promise<void> {
    console.log(`[plivo:stub] hangup call=${callUuid}`);
  }
  async originate(args: {
    from: string;
    to: string;
    answerUrl: string;
  }): Promise<{ requestUuid: string }> {
    console.log(
      `[plivo:stub] originate from=${args.from} to=${args.to} answerUrl=${args.answerUrl}`,
    );
    return { requestUuid: `stub-${Date.now()}` };
  }
  async sendDigits(callUuid: string, digits: string): Promise<void> {
    console.log(`[plivo:stub] sendDigits call=${callUuid} digits=${digits} (no-op in stub mode)`);
  }
  async startStream(args: { callUuid: string; serviceUrl: string }): Promise<{ streamId?: string }> {
    console.log(
      `[plivo:stub] startStream call=${args.callUuid} url=${args.serviceUrl} (no-op in stub mode)`,
    );
    return { streamId: `stub-stream-${Date.now()}` };
  }
}

// ---- Real Plivo (multi-account) -------------------------------------------

class RealPlivoClient implements PlivoCallClient {
  // Lazy per-account clients so we only import + auth what we use.
  private clientPromiseByAccount = new Map<string, Promise<any>>();

  private async client(accountId?: '1' | '2'): Promise<any> {
    const slot = accountId ?? '1';
    let p = this.clientPromiseByAccount.get(slot);
    if (!p) {
      p = (async () => {
        const plivo = await import('plivo');
        const acct = account(slot);
        return new plivo.Client(acct.id, acct.token);
      })();
      this.clientPromiseByAccount.set(slot, p);
    }
    return p;
  }

  async hangup(callUuid: string, accountId?: '1' | '2'): Promise<void> {
    const client = await this.client(accountId);
    await client.calls.hangup(callUuid);
  }

  async originate(args: {
    from: string;
    to: string;
    answerUrl: string;
    accountId?: '1' | '2';
  }): Promise<{ requestUuid: string }> {
    // Route the originate via the account that's footing the bill — that's
    // the account that owns the caller-id `from` DID. If accountId is
    // omitted, we look it up from the agent registry.
    const slot = args.accountId ?? accountForCallNumber(args.from) ?? '1';
    const client = await this.client(slot);
    const resp = await client.calls.create(args.from, args.to, args.answerUrl);
    return { requestUuid: resp.requestUuid ?? resp.request_uuid ?? 'unknown' };
  }

  async sendDigits(callUuid: string, digits: string, accountId?: '1' | '2'): Promise<void> {
    const client = await this.client(accountId);
    await client.calls.sendDigits(callUuid, digits);
  }

  async startStream(args: {
    callUuid: string;
    serviceUrl: string;
    accountId?: '1' | '2';
    bidirectional?: boolean;
    audioTrack?: 'inbound' | 'outbound' | 'both';
  }): Promise<{ streamId?: string }> {
    const acct = account(args.accountId);
    const url = `https://api.plivo.com/v1/Account/${acct.id}/Call/${args.callUuid}/Stream/`;
    const bidi = args.bidirectional ?? true;
    const track = args.audioTrack ?? (bidi ? 'inbound' : 'both');
    const body = {
      service_url: args.serviceUrl,
      bidirectional: bidi,
      audio_track: track,
      content_type: 'audio/x-mulaw;rate=8000',
      status_callback_url: deriveStatusCallback(),
      status_callback_method: 'POST',
    };
    const auth = Buffer.from(`${acct.id}:${acct.token}`).toString('base64');

    // /api/answer fires the moment Plivo runs the answer URL — for the
    // inbound (dialed) leg the call may not be fully registered in
    // Plivo's REST API yet, returning 404 "call not found". Retry with a
    // short backoff until it's there.
    const RETRIES = [0, 400, 800, 1500];
    let lastErr = '';
    for (const delayMs of RETRIES) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { stream_id?: string };
        return { streamId: json.stream_id };
      }
      lastErr = `status=${res.status} body=${(await res.text().catch(() => '')).slice(0, 200)}`;
      // Don't bother retrying on auth failure.
      if (res.status === 401 || res.status === 403) break;
    }
    throw new Error(`startStream failed after retries: ${lastErr}`);
  }
}

function deriveStatusCallback(): string {
  const publicHost = (process.env.PUBLIC_HOST ?? `localhost:${process.env.PORT ?? 3000}`)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const scheme = publicHost.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${publicHost}/api/stream-status`;
}

export const plivoClient: PlivoCallClient = USE_STUBS ? new StubPlivoClient() : new RealPlivoClient();
