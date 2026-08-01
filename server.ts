/**
 * Custom Next.js server with attached WebSocket endpoints.
 *
 * We need a custom server because Next's API routes don't natively host
 * long-lived WebSocket connections cleanly. Here Next handles HTTP, and
 * the `ws` library handles `/voice/:call_uuid` and `/data/:session_id`.
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';

import { handleVoiceConnection } from './src/ws/voiceHandler';
import { handleDataConnection } from './src/ws/dataHandler';
import { eventBus } from './src/lib/eventBus';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev });
const handle = app.getRequestHandler();

const VOICE_PATH = /^\/voice\/([^/]+)$/;
const DATA_PATH = /^\/data\/([^/]+)$/;

async function main(): Promise<void> {
  await app.prepare();

  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? '', true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const ua = request.headers['user-agent'] ?? 'unknown';
    const xff = request.headers['x-forwarded-for'] ?? '';
    console.log(`[upgrade] url=${request.url} ua=${ua} xff=${xff}`);
    const { pathname } = parse(request.url ?? '');
    if (!pathname) {
      console.warn(`[upgrade] no pathname, destroying`);
      socket.destroy();
      return;
    }

    const voiceMatch = VOICE_PATH.exec(pathname);
    const dataMatch = DATA_PATH.exec(pathname);

    if (voiceMatch) {
      const callUuid = decodeURIComponent(voiceMatch[1]);
      console.log(`[upgrade] voice match call=${callUuid}`);
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        handleVoiceConnection(ws, callUuid).catch((err) => {
          console.error(`[voice] handler crashed call=${callUuid}`, err);
          ws.close();
        });
      });
      return;
    }

    if (dataMatch) {
      const sessionId = decodeURIComponent(dataMatch[1]);
      console.log(`[upgrade] data match session=${sessionId}`);
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        handleDataConnection(ws, sessionId).catch((err) => {
          console.error(`[data] handler crashed session=${sessionId}`, err);
          ws.close();
        });
      });
      return;
    }

    console.warn(`[upgrade] no route match for ${pathname}, destroying socket`);
    socket.destroy();
  });

  httpServer.listen(port, () => {
    console.log(`[tonecall] http+ws listening on http://localhost:${port}`);
    console.log(`[tonecall] dev=${dev} stubs=${process.env.USE_STUBS ?? 'true'}`);
    eventBus.emit('server:ready', { port });
  });
}

main().catch((err) => {
  console.error('[tonecall] fatal', err);
  process.exit(1);
});
