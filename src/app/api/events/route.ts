import { NextRequest } from 'next/server';
import { eventBus } from '@/lib/eventBus';
import type { DemoEvent } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * Server-sent events feed for the demo dashboard.
 * Streams every DemoEvent published on the in-process eventBus.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: DemoEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* connection closed */
        }
      };

      // Initial hello so the browser knows it's connected.
      controller.enqueue(encoder.encode(`: connected\n\n`));

      const unsubscribe = eventBus.subscribeDemo(send);

      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(ping);
          unsubscribe();
        }
      }, 15_000);

      _req.signal.addEventListener('abort', () => {
        clearInterval(ping);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
