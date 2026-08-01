import { EventEmitter } from 'events';
import type { DemoEvent } from '@/types';

/**
 * In-process pub/sub for the demo UI.
 *
 * Backed by globalThis — see callRegistry.ts for why.
 *
 * Cross-instance forwarding: if FORWARD_EVENTS_TO is set, every published
 * event is also POSTed to `${FORWARD_EVENTS_TO}/api/forward-event`. That
 * lets a follower middleware ship its events to a leader middleware so a
 * single dashboard sees everything from both sides of the federation.
 *
 * To avoid loops, forwarded events arriving on `/api/forward-event` are
 * re-emitted on the LOCAL bus only — never re-forwarded.
 */

const FORWARD_TO = (process.env.FORWARD_EVENTS_TO ?? '').replace(/\/$/, '');

class TypedEventBus extends EventEmitter {
  /** Publish locally and (if configured) forward to the leader's HTTP endpoint. */
  publishDemo(event: DemoEvent): void {
    this.emit('demo', event);
    if (FORWARD_TO) {
      // Fire-and-forget. We deliberately don't await — if the leader's
      // dashboard is down, the local bus still works.
      void fetch(`${FORWARD_TO}/api/forward-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }).catch((err) => console.warn(`[eventBus] forward failed:`, err.message ?? err));
    }
  }

  /** Like publishDemo but never forwards — used by /api/forward-event to avoid loops. */
  publishLocal(event: DemoEvent): void {
    this.emit('demo', event);
  }

  subscribeDemo(handler: (event: DemoEvent) => void): () => void {
    this.on('demo', handler);
    return () => this.off('demo', handler);
  }
}

const G = globalThis as unknown as { __tonecall_event_bus?: TypedEventBus };
export const eventBus: TypedEventBus = (G.__tonecall_event_bus ??= (() => {
  const bus = new TypedEventBus();
  bus.setMaxListeners(100);
  return bus;
})());
