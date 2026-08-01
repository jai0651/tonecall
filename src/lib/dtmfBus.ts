/**
 * Per-number DTMF event bus.
 *
 * Plivo emits a stream WS for each of the TWO call_uuids it bookkeeps per
 * PSTN leg (call this the "twin pair"). When DTMF arrives in the audio,
 * the dtmf event fires on ONE of the two twins — empirically, the
 * "outbound" twin (the one matching the requestUuid from originate), not
 * the "inbound" twin we listen on for TTS playback.
 *
 * The state machine takes a lock to run the handshake on only ONE twin
 * per agent number. We can't know in advance which twin will be the
 * lock-holder vs the one receiving DTMF — so we fork: every twin's
 * voiceHandler pushes every dtmf event it sees into a per-number bus,
 * and the state machine's handshake listens on the bus. That way, the
 * lock-holder's handshake sees DTMF from both twins.
 */

import { EventEmitter } from 'events';

type DtmfEvent = { digit: string; callUuid: string; ts: number };

class TypedDtmfBus extends EventEmitter {
  publish(number: string, digit: string, callUuid: string): void {
    this.emit(number, { digit, callUuid, ts: Date.now() } satisfies DtmfEvent);
  }

  /** Subscribe to DTMF events on `number`. Returns an unsubscribe function. */
  subscribe(number: string, handler: (e: DtmfEvent) => void): () => void {
    this.on(number, handler);
    return () => this.off(number, handler);
  }
}

const G = globalThis as unknown as { __tonecall_dtmf_bus?: TypedDtmfBus };
export const dtmfBus: TypedDtmfBus =
  (G.__tonecall_dtmf_bus ??= (() => {
    const b = new TypedDtmfBus();
    b.setMaxListeners(100);
    return b;
  })());
