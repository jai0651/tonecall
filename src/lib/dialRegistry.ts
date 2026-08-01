/**
 * Dial-role registry — which leg Dials out, and to whom.
 *
 * AVIP-1 topology: /api/trigger-call originates ONE call to the local agent's
 * DID and stashes a pending dial target here. When /api/answer fires for that
 * DID, it claims the target and returns <Stream> + <Dial> XML (the
 * "initiator" leg). Every other leg — the dialed-into peer DID, or a human
 * calling in — gets <Stream> + <Wait> (a "responder" leg).
 *
 * The role also drives the in-band handshake: the initiator proactively
 * plays its DTMF preamble; a responder only answers after hearing one. That
 * way a human caller never hears unsolicited beeps.
 *
 * Claims are keyed by callUuid so Plivo webhook retries for the same call
 * get the same XML back, while a twin call_uuid for the same number can
 * never trigger a second <Dial>.
 *
 * Backed by globalThis so the Next.js API graph and the custom server share
 * one map (same pattern as callRegistry).
 */

const ENTRY_TTL_MS = 60_000; // the originated call should be answered within seconds

export type DialRole = 'initiator' | 'responder';

type PendingDial = {
  target: string;
  expiresAt: number;
  claimedByCallUuid: string | null;
};

const G = globalThis as unknown as {
  __tonecall_pending_dials?: Map<string, PendingDial>;
  __tonecall_dial_roles?: Map<string, DialRole>;
};
const pendingByNumber = (G.__tonecall_pending_dials ??= new Map<string, PendingDial>());
const roleByCallUuid = (G.__tonecall_dial_roles ??= new Map<string, DialRole>());

/** Stash "when `fromNumber` answers, Dial `toNumber`" (set by /api/trigger-call). */
export function setPendingDial(fromNumber: string, toNumber: string): void {
  pendingByNumber.set(normalize(fromNumber), {
    target: normalize(toNumber),
    expiresAt: Date.now() + ENTRY_TTL_MS,
    claimedByCallUuid: null,
  });
}

/**
 * Claim the pending dial target for this agent number.
 *
 * Returns the target number if this callUuid is (or becomes) the initiator
 * leg, else null. Idempotent per callUuid — a webhook retry for the claiming
 * call gets the same target back; any OTHER callUuid for the same number
 * gets null so we never fan out two <Dial>s for one trigger.
 */
export function claimDialTarget(agentNumber: string, callUuid: string): string | null {
  const key = normalize(agentNumber);
  const entry = pendingByNumber.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pendingByNumber.delete(key);
    return null;
  }
  if (entry.claimedByCallUuid === callUuid) return entry.target;
  if (entry.claimedByCallUuid) return null;
  entry.claimedByCallUuid = callUuid;
  roleByCallUuid.set(callUuid, 'initiator');
  return entry.target;
}

/**
 * Explicitly mark a leg as handshake initiator. Used by the simulator, which
 * has no /api/answer step to claim a role through.
 */
export function markDialInitiator(callUuid: string): void {
  roleByCallUuid.set(callUuid, 'initiator');
}

/** Handshake role for a leg. Anything that never claimed a dial is a responder. */
export function getDialRole(callUuid: string): DialRole {
  return roleByCallUuid.get(callUuid) ?? 'responder';
}

/** Drop role bookkeeping for a finished call (called on voice WS teardown). */
export function clearDialRole(callUuid: string): void {
  roleByCallUuid.delete(callUuid);
}

function normalize(n: string): string {
  const t = n.trim();
  if (t.startsWith('+')) return t;
  if (/^\d+$/.test(t)) return '+' + t;
  return t;
}
