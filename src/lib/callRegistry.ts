/**
 * Maps Plivo call_uuid → which phone number this leg belongs to.
 *
 * Backed by globalThis because Next.js compiles its API route module graph
 * separately from our custom server.ts process graph; without this, a Map
 * declared at module scope ends up duplicated and the two graphs lose state.
 */

const G = globalThis as unknown as { __tonecall_call_registry?: Map<string, string> };
const map = (G.__tonecall_call_registry ??= new Map<string, string>());

export function registerCall(callUuid: string, number: string): void {
  map.set(callUuid, number);
}

export function lookupNumberForCall(callUuid: string): string | undefined {
  return map.get(callUuid);
}

export function unregisterCall(callUuid: string): void {
  map.delete(callUuid);
}
