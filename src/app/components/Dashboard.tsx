'use client';

import { useEffect, useRef, useState } from 'react';
import type { DemoEvent, AgentJsonMessage, PhaseName } from '@/types';

type AgentLine = { from: string; text: string; ts: number };
type VoiceLine = { speaker: string; text: string; ts: number };

type CallMeta = {
  startedAt?: number;
  endedAt?: number;
  pairedAt?: number;
  timeoutAt?: number;
  mode?: 'agent_to_agent' | 'human_to_agent';
  pairingPath?: 'in_band_nonce';
};

type PhaseTiming = { startedAt?: number; endedAt?: number; durationMs?: number; turns?: number };

type DemoSummary = {
  voiceMs: number;
  dataMs: number;
  voiceTurns: number;
  dataTurns: number;
  voiceBaselineMs: number;
  latencySavedMs: number;
  costUsdActual: number;
  costUsdBaseline: number;
  costSavedUsd: number;
};

const NUMBERS = {
  vegetable_vendor: process.env.NEXT_PUBLIC_PLIVO_NUMBER_A ?? '+1-480-790-6332',
  pizza_shop: process.env.NEXT_PUBLIC_PLIVO_NUMBER_B ?? '+1-678-400-6155',
};

export function Dashboard() {
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const [voiceLog, setVoiceLog] = useState<VoiceLine[]>([]);
  const [meta, setMeta] = useState<CallMeta>({});
  const [phases, setPhases] = useState<Record<PhaseName, PhaseTiming>>({
    voice_intro: {},
    data_exchange: {},
    voice_goodbye: {},
    human_voice: {},
  });
  const [summary, setSummary] = useState<DemoSummary | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [activePhase, setActivePhase] = useState<PhaseName | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    sourceRef.current = es;
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as DemoEvent;
        handleEvent(event, {
          setAgentLog,
          setVoiceLog,
          setMeta,
          setPhases,
          setSummary,
          setActivePhase,
        });
      } catch {
        /* ignore */
      }
    };
    return () => {
      es.close();
    };
  }, []);

  const trigger = async () => {
    setTriggering(true);
    setAgentLog([]);
    setVoiceLog([]);
    setMeta({ startedAt: Date.now() });
    setPhases({
      voice_intro: {},
      data_exchange: {},
      voice_goodbye: {},
      human_voice: {},
    });
    setSummary(null);
    setActivePhase(null);

    // Hard timeout on the fetch so the button is never stuck in "Dialing…"
    // even if the network round-trip stalls. The actual call lifecycle
    // updates come over the SSE event stream, not from this fetch's reply.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/trigger-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn('[trigger] response not ok', res.status, await res.text());
      }
    } catch (err) {
      const msg = (err as Error)?.name === 'AbortError'
        ? 'trigger fetch timed out — call may still be running, watch event stream'
        : `trigger fetch failed: ${(err as Error)?.message}`;
      console.warn('[trigger]', msg);
    } finally {
      clearTimeout(timeout);
      setTriggering(false);
    }
  };

  const elapsedMs = meta.startedAt ? (meta.endedAt ?? Date.now()) - meta.startedAt : 0;
  const liveVoiceMs = phases.voice_intro.durationMs ?? 0;
  const liveDataMs = phases.data_exchange.durationMs ?? 0;
  const liveGoodbyeMs = phases.voice_goodbye.durationMs ?? 0;

  return (
    <main className="min-h-screen p-6">
      <header className="flex items-start justify-between border-b border-neutral-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold">Tonecall</h1>
          <p className="mt-1 text-sm text-neutral-400">
            A handshake protocol for AI voice agents. When both ends of a call are agents, drop the
            voice channel and switch to a JSON side-channel. When a human is on the line, stay in
            voice.
          </p>
          <div className="mt-2 flex gap-4 text-xs text-neutral-500">
            <span>
              <span className="text-neutral-400">vegetable_vendor</span> &middot; {NUMBERS.vegetable_vendor}
            </span>
            <span>
              <span className="text-neutral-400">pizza_shop</span> &middot; {NUMBERS.pizza_shop}
            </span>
          </div>
        </div>
        <button
          onClick={trigger}
          disabled={triggering}
          className="rounded-md bg-chirp-500 px-4 py-2 text-sm font-semibold text-black hover:bg-chirp-50 disabled:opacity-50"
        >
          {triggering ? 'Dialing…' : 'Trigger agent ↔ agent demo'}
        </button>
      </header>

      {/* Mode + pairing path + phase strip */}
      <section className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        <ModeBadge mode={meta.mode} />
        <PairingPathBadge path={meta.pairingPath} mode={meta.mode} />
        <PhaseChip name="voice_intro" label="Voice intro" timing={phases.voice_intro} active={activePhase === 'voice_intro'} />
        <PhaseChip name="data_exchange" label="Data exchange" timing={phases.data_exchange} active={activePhase === 'data_exchange'} />
        <PhaseChip name="voice_goodbye" label="Voice goodbye" timing={phases.voice_goodbye} active={activePhase === 'voice_goodbye'} />
        {meta.mode === 'human_to_agent' && (
          <PhaseChip name="human_voice" label="Human voice" timing={phases.human_voice} active={activePhase === 'human_voice'} />
        )}
        <span className="ml-auto text-neutral-500">elapsed {(elapsedMs / 1000).toFixed(1)}s</span>
      </section>

      {/* Live metrics + savings */}
      <section className="mt-4 grid grid-cols-4 gap-3 text-sm">
        <Metric
          label="Voice time"
          value={`${msToSec(liveVoiceMs + liveGoodbyeMs)}s`}
          sub={`${(phases.voice_intro.turns ?? 0) + (phases.voice_goodbye.turns ?? 0)} turns · ~4s/turn`}
        />
        <Metric
          label="Data time"
          value={`${msToSec(liveDataMs)}s`}
          sub={`${phases.data_exchange.turns ?? 0} turns · ~${liveDataMs && phases.data_exchange.turns ? Math.round(liveDataMs / phases.data_exchange.turns) : '—'}ms/turn`}
          accent
        />
        <Metric
          label="Latency saved"
          value={summary ? `${msToSec(summary.latencySavedMs)}s` : '—'}
          sub={
            summary
              ? `voice baseline: ${msToSec(summary.voiceBaselineMs)}s`
              : 'computed at end'
          }
          accent={!!summary && summary.latencySavedMs > 0}
        />
        <Metric
          label="Cost saved"
          value={summary ? `$${summary.costSavedUsd.toFixed(3)}` : '—'}
          sub={
            summary
              ? `actual $${summary.costUsdActual.toFixed(3)} vs baseline $${summary.costUsdBaseline.toFixed(3)}`
              : '—'
          }
          accent={!!summary && summary.costSavedUsd > 0}
        />
      </section>

      {/* Two-pane transcript */}
      <section className="mt-6 grid grid-cols-2 gap-4">
        <Lane
          title="VOICE plane"
          subtitle="What a human listening to the call would hear · STT→LLM→TTS · ~4s/turn"
        >
          {voiceLog.length === 0 && <Empty>No voice yet — click the trigger button or dial one of the numbers.</Empty>}
          {voiceLog.map((line, i) => (
            <div key={i} className="mb-2">
              <span className={line.speaker === 'system' ? 'text-neutral-500 italic' : 'text-chirp-500'}>
                {line.speaker}:
              </span>{' '}
              <span className="text-neutral-200">{line.text}</span>
            </div>
          ))}
        </Lane>

        <Lane
          title="DATA plane"
          subtitle="Tonecall side-channel · JSON over WebSocket · ~50ms/turn"
        >
          {agentLog.length === 0 && <Empty>No paired exchange yet.</Empty>}
          {agentLog.map((line, i) => (
            <div key={i} className="mb-2">
              <span className="text-chirp-500">{line.from}:</span>{' '}
              <code className="break-all text-neutral-200">{line.text}</code>
            </div>
          ))}
        </Lane>
      </section>

      {/* "What if a human calls" explainer */}
      <section className="mt-6 rounded-md border border-neutral-800 bg-neutral-900/50 p-4 text-sm">
        <div className="mb-1 font-semibold text-neutral-200">
          What happens if a real human calls one of these numbers?
        </div>
        <div className="text-neutral-400">
          The middleware sees no pre-coordinated session for the inbound call, marks the peer as
          human, and runs the standard voice loop (Whisper STT → GPT-5.2 → tts-1). No handshake, no
          data channel — just a normal phone agent. Try it: dial{' '}
          <code className="text-neutral-200">{NUMBERS.vegetable_vendor}</code> or{' '}
          <code className="text-neutral-200">{NUMBERS.pizza_shop}</code> from your phone and watch
          the Voice plane fill up while the Data plane stays empty.
        </div>
      </section>
    </main>
  );
}

// ----- Event handler --------------------------------------------------------

type Setters = {
  setAgentLog: React.Dispatch<React.SetStateAction<AgentLine[]>>;
  setVoiceLog: React.Dispatch<React.SetStateAction<VoiceLine[]>>;
  setMeta: React.Dispatch<React.SetStateAction<CallMeta>>;
  setPhases: React.Dispatch<React.SetStateAction<Record<PhaseName, PhaseTiming>>>;
  setSummary: React.Dispatch<React.SetStateAction<DemoSummary | null>>;
  setActivePhase: React.Dispatch<React.SetStateAction<PhaseName | null>>;
};

function handleEvent(event: DemoEvent, s: Setters): void {
  switch (event.kind) {
    case 'call.triggered':
      s.setMeta((m) => ({ ...m, startedAt: event.ts, endedAt: undefined }));
      return;
    case 'call.mode':
      s.setMeta((m) => ({ ...m, mode: event.mode }));
      return;
    case 'handshake.paired':
      s.setMeta((m) => ({ ...m, pairedAt: event.ts }));
      return;
    case 'handshake.timeout':
      s.setMeta((m) => ({ ...m, timeoutAt: event.ts }));
      return;
    case 'pairing.summary':
      s.setMeta((m) => ({ ...m, pairingPath: event.path, pairedAt: m.pairedAt ?? event.ts }));
      return;
    case 'phase.started':
      s.setActivePhase(event.phase);
      s.setPhases((p) => ({ ...p, [event.phase]: { ...p[event.phase], startedAt: event.ts } }));
      return;
    case 'phase.ended':
      s.setActivePhase((cur) => (cur === event.phase ? null : cur));
      s.setPhases((p) => ({
        ...p,
        [event.phase]: {
          ...p[event.phase],
          endedAt: event.ts,
          durationMs: event.durationMs,
          turns: event.turns,
        },
      }));
      return;
    case 'demo.summary':
      s.setSummary({
        voiceMs: event.voiceMs,
        dataMs: event.dataMs,
        voiceTurns: event.voiceTurns,
        dataTurns: event.dataTurns,
        voiceBaselineMs: event.voiceBaselineMs,
        latencySavedMs: event.latencySavedMs,
        costUsdActual: event.costUsdActual,
        costUsdBaseline: event.costUsdBaseline,
        costSavedUsd: event.costSavedUsd,
      });
      return;
    case 'call.ended':
      s.setMeta((m) => ({ ...m, endedAt: m.endedAt ?? event.ts }));
      return;
    case 'agent.message':
      s.setAgentLog((log) => [
        ...log,
        { from: event.from, text: prettyJson(event.payload), ts: event.ts },
      ]);
      return;
    case 'voice.transcript':
      s.setVoiceLog((log) => [...log, { speaker: event.speaker, text: event.text, ts: event.ts }]);
      return;
    default:
      return;
  }
}

// ----- View atoms -----------------------------------------------------------

function prettyJson(p: AgentJsonMessage): string {
  return JSON.stringify(p);
}

function msToSec(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${accent ? 'border-chirp-500/60 bg-chirp-500/5' : 'border-neutral-800'}`}
    >
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${accent ? 'text-chirp-50' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function PhaseChip({
  name,
  label,
  timing,
  active,
}: {
  name: PhaseName;
  label: string;
  timing: PhaseTiming;
  active: boolean;
}) {
  const done = timing.durationMs != null;
  const cls = active
    ? 'border-chirp-500 bg-chirp-500/10 text-chirp-50 animate-pulse'
    : done
      ? 'border-chirp-500/40 bg-chirp-500/5 text-neutral-200'
      : 'border-neutral-800 text-neutral-500';
  return (
    <span className={`rounded-full border px-3 py-1 ${cls}`} title={name}>
      {label}
      {done && <span className="ml-1 text-neutral-500">· {msToSec(timing.durationMs!)}s</span>}
    </span>
  );
}

function ModeBadge({ mode }: { mode?: CallMeta['mode'] }) {
  if (!mode) return null;
  const label = mode === 'agent_to_agent' ? 'Agent ↔ Agent' : 'Human → Agent';
  const cls =
    mode === 'agent_to_agent'
      ? 'border-chirp-500/60 bg-chirp-500/10 text-chirp-50'
      : 'border-amber-500/60 bg-amber-500/10 text-amber-200';
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${cls}`}>{label}</span>
  );
}

function PairingPathBadge({
  path,
  mode,
}: {
  path?: CallMeta['pairingPath'];
  mode?: CallMeta['mode'];
}) {
  // Only relevant in agent ↔ agent mode.
  if (mode !== 'agent_to_agent' || !path) return null;
  return (
    <span
      title="Both legs exchanged DTMF nonces in-band over the Dial bridge (Plivo sendDTMF event); broker matched them cross-wise. Works cross-vendor / direct PSTN bridge."
      className="rounded-full border border-emerald-500/60 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200"
    >
      AVIP-1 paired · in-band nonce
    </span>
  );
}

function Lane({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="h-[55vh] overflow-auto rounded-md border border-neutral-800 p-4">
      <div className="mb-1 text-sm font-semibold">{title}</div>
      <div className="mb-3 text-xs text-neutral-500">{subtitle}</div>
      <div className="font-mono text-xs leading-relaxed">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-neutral-600">{children}</div>;
}
