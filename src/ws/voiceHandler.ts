/**
 * Voice WebSocket handler — one per call leg.
 *
 * Plivo opens this when a call answered with <Stream> connects. We:
 *   1. Look up which phone number / agent this leg belongs to.
 *   2. Forward Plivo's `dtmf` events onto the per-number bus (the in-band
 *      nonce handshake in stateMachine.ts listens for the peer's preamble
 *      here — DTMF crosses the Dial bridge leg-to-leg).
 *   3. Run the handshake state machine.
 *   4. Optionally tee the inbound mu-law into a debug capture file or a
 *      local `play` subprocess so the dev can inspect the conference audio.
 */

import type { WebSocket } from 'ws';
import { createWriteStream, type WriteStream } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { lookupNumberForCall, unregisterCall } from '@/lib/callRegistry';
import { clearDialRole } from '@/lib/dialRegistry';
import { getAgentConfig } from '@/lib/agentConfigs';
import { eventBus } from '@/lib/eventBus';
import { dtmfBus } from '@/lib/dtmfBus';
import { decodeFrame } from '@/lib/audio';
import type { PlivoStreamEvent } from '@/types';
import { runStateMachine } from './stateMachine';

// Per-number live-play subprocess, so the twin call_uuid for the same agent
// doesn't double up audio. The first leg per number spawns the player; the
// twin skips. Cleaned up when both ws close.
const livePlayers = (globalThis as unknown as {
  __tonecall_live_players?: Map<string, { proc: ChildProcess; refs: number }>;
}).__tonecall_live_players ??= new Map();

export async function handleVoiceConnection(ws: WebSocket, callUuid: string): Promise<void> {
  // Plivo doesn't always populate the answer URL before the stream opens —
  // give the callRegistry a brief grace window in case events race.
  const number = await waitForRegistration(callUuid, 1000);
  if (!number) {
    console.warn(`[voice] no registered number for call=${callUuid}, closing`);
    ws.close();
    return;
  }

  const config = getAgentConfig(number);
  if (!config) {
    console.warn(`[voice] no agent config for number=${number}, closing`);
    ws.close();
    return;
  }

  console.log(`[voice] open call=${callUuid} agent=${config.name} number=${number}`);
  eventBus.publishDemo({ kind: 'handshake.started', callUuid, ts: Date.now() });

  // Optional raw-audio capture: when AVIP_CAPTURE=1, write every inbound mu-law
  // frame to /tmp/avip-capture-<callUuid>.mulaw so we can inspect the actual
  // conference audio offline. 8kHz mu-law, single channel; convert with:
  //   sox -t ul -r 8000 -c 1 in.mulaw out.wav
  let capture: WriteStream | null = null;
  if (process.env.AVIP_CAPTURE === '1') {
    const path = `/tmp/avip-capture-${number}-${callUuid}.mulaw`;
    capture = createWriteStream(path);
    console.log(`[capture] writing inbound mu-law to ${path}`);
  }

  // Optional live audio playback: when AVIP_PLAY=1, spawn a sox `play`
  // subprocess and pipe every inbound mu-law frame to its stdin. Each agent
  // is panned to a different stereo channel so the dev can distinguish them.
  // Requires sox (`brew install sox` on macOS).
  let player: ChildProcess | null = null;
  let playerKey: string | null = null;
  let isAudioWriter = false;
  if (process.env.AVIP_PLAY === '1') {
    const isLeft = config.name === 'vegetable_vendor';
    const isRight = config.name === 'pizza_shop';
    const panArg = isLeft ? '-1' : isRight ? '1' : '0';
    const where = isLeft ? 'LEFT' : isRight ? 'RIGHT' : 'CENTER';
    playerKey = number;
    const existing = livePlayers.get(playerKey);
    if (existing) {
      existing.refs += 1;
      console.log(`[play] hold ref for ${config.name} (twin call=${callUuid}, refs=${existing.refs})`);
    } else {
      try {
        const proc = spawn('play', [
          '-q', '-t', 'ul', '-r', '8000', '-c', '1', '-',
          'remix', '1,1',
          'pan', panArg,
        ], { stdio: ['pipe', 'ignore', 'pipe'] });
        proc.on('error', (err) => {
          console.warn(`[play] spawn failed for ${number}: ${err.message} (is sox installed?)`);
          livePlayers.delete(playerKey!);
        });
        proc.stderr?.on('data', () => { /* swallow sox warnings */ });
        livePlayers.set(playerKey, { proc, refs: 1 });
        player = proc;
        isAudioWriter = true;
        console.log(`[play] live ${config.name} → ${where} speaker (call=${callUuid})`);
      } catch (err) {
        console.warn(`[play] spawn threw for ${number}: ${(err as Error).message}`);
        player = null;
        playerKey = null;
      }
    }
  }

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString();
    const event = parsePlivoEvent(raw);
    if (!event) return;

    if (event.event === 'dtmf') {
      // Forward to the per-number bus. Only the in-band nonce handshake
      // path in stateMachine.ts subscribes; on conference-paired calls
      // (the production Plivo flow) nothing listens, which is fine.
      console.log(
        `[DTMF-RX] call=${callUuid} number=${number} digit=${event.dtmf.digit} ` +
          `track=${event.dtmf.track ?? '?'}`,
      );
      dtmfBus.publish(number, event.dtmf.digit, callUuid);
      return;
    }

    if (event.event === 'media' && event.media?.payload) {
      const frame = decodeFrame(event.media.payload);
      capture?.write(frame);
      if (isAudioWriter && player?.stdin?.writable) {
        player.stdin.write(frame);
      }
    }
  });

  ws.on('close', () => {
    capture?.end();
    if (playerKey) {
      const entry = livePlayers.get(playerKey);
      if (entry) {
        entry.refs -= 1;
        if (entry.refs <= 0) {
          try { entry.proc.stdin?.end(); } catch { /* ignore */ }
          setTimeout(() => { try { entry.proc.kill(); } catch {} }, 1000);
          livePlayers.delete(playerKey);
        }
      }
    }
  });

  const startedAt = Date.now();
  try {
    await runStateMachine({ ws, callUuid, config });
  } catch (err) {
    console.error(`[voice] state machine error call=${callUuid}`, err);
  } finally {
    unregisterCall(callUuid);
    clearDialRole(callUuid);
    ws.close();
    eventBus.publishDemo({
      kind: 'call.ended',
      callUuid,
      durationMs: Date.now() - startedAt,
      ts: Date.now(),
    });
    console.log(`[voice] closed call=${callUuid}`);
  }
}

async function waitForRegistration(callUuid: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let number = lookupNumberForCall(callUuid);
  while (!number && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    number = lookupNumberForCall(callUuid);
  }
  return number;
}

/** Parse a Plivo WS frame; returns null for ignorable / malformed payloads. */
export function parsePlivoEvent(raw: string): PlivoStreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as PlivoStreamEvent;
    if (typeof parsed === 'object' && parsed !== null && 'event' in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
