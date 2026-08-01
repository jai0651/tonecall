# Tonecall

**Inter-Agent Voice Handshake** — a protocol middleware for AI voice agents.
When two agents end up on the same phone call, drop the slow voice channel
and switch to a JSON side-channel. When the peer is a human, stay in voice
the whole time.

```
caller → +1-NUMBER → Plivo → tonecall middleware →
  ├─ peer is an agent  → voice intro → JSON over /data WS → voice goodbye
  │                       (~10s)         (~3s, fast path)      (~5s)
  └─ peer is a human   → STT → LLM → TTS loop                  (~4-6s/turn)
```

The full design + runtime diagrams live in
[`docs/architecture.md`](./docs/architecture.md). For a granular,
everything-explained walkthrough of the current code, open
[`docs/deep-dive/index.html`](./docs/deep-dive/index.html) in a browser
(7 linked pages: lifecycle, handshake, pairing, audio, federation, state).
This README is the quick-start.

## Repo layout

```
server.ts                  # Next.js + ws (one process)
src/app/                   # Demo dashboard + API routes
src/ws/                    # voice + data WebSocket handlers, orchestrator
src/lib/                   # Plivo, OpenAI LLM/STT/TTS, codecs, registries
docs/                      # Architecture + protocol writeups
tonecall_audio/            # (created at runtime) WAV recordings of each utterance
```

## Run modes

### A) Pure-local simulation (no Plivo, no ngrok, no API keys)

```bash
npm install
cp .env.example .env       # USE_STUBS=true is the default
npm run dev
curl -X POST http://localhost:3000/api/simulate
```

Open <http://localhost:3000> — the dashboard shows the full 4-phase flow
against stubbed LLM/STT/TTS.

### A2) Federated two-middleware simulation — the default AVIP topology

Two independent processes, each owning ONE agent, pairing purely through
the in-band DTMF handshake + the broker (see `docs/avip-1-dial.md`):

```bash
npm run dev:a              # terminal 1 — vegetable_vendor + broker on :3000
npm run dev:b              # terminal 2 — pizza_shop on :3001

curl -X POST http://localhost:3000/api/simulate \
  -H 'Content-Type: application/json' \
  -d '{"peerBase":"http://localhost:3001"}'
```

Instance B forwards its events to :3000, so one dashboard shows both legs.

### B) Live demo with real Plivo + OpenAI

#### 1. Get credentials

- **Plivo** — sign up at <https://console.plivo.com>. You'll need **two
  voice-enabled DIDs** for the agent endpoints, plus a third one to use as
  caller-ID for the originate.
- **OpenAI** — `OPENAI_API_KEY` from <https://platform.openai.com/api-keys>.
  One key powers all three: LLM (default `gpt-5.2`), STT (`whisper-1`),
  TTS (`tts-1`).

#### 2. Expose the dev server

```bash
ngrok http 3000
```

Copy the public hostname (e.g. `abcd-1234.ngrok-free.dev` — **no scheme,
no trailing slash**).

#### 3. Configure `.env`

```env
PORT=3000
USE_STUBS=false
PUBLIC_HOST=abcd-1234.ngrok-free.dev

PLIVO_AUTH_ID=MA...
PLIVO_AUTH_TOKEN=...
PLIVO_NUMBER_A=+1AAAAAAAAAA
PLIVO_NUMBER_B=+1BBBBBBBBBB
PLIVO_CALLER_ID=+1CCCCCCCCCC

OPENAI_API_KEY=sk-...
OPENAI_LLM_MODEL=gpt-5.2
OPENAI_STT_MODEL=whisper-1
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=alloy        # fallback; per-agent voices override

NEXT_PUBLIC_PLIVO_NUMBER_A=+1AAAAAAAAAA   # what the dashboard displays
NEXT_PUBLIC_PLIVO_NUMBER_B=+1BBBBBBBBBB

# Optional — hear the agents through your laptop speakers in real time
PLAY_LOCAL=true
RECORD_AUDIO=true             # also dump every utterance to ./tonecall_audio/
```

#### 4. Point both Plivo numbers at tonecall

In the Plivo console:

1. Create an **Application** with:
   - **Answer URL**: `https://<PUBLIC_HOST>/api/answer`  (POST, no template)
   - **Hangup URL**: `https://<PUBLIC_HOST>/api/hangup`  (POST, optional)
2. Attach that application to **both** `PLIVO_NUMBER_A` and `PLIVO_NUMBER_B`.

Why a static URL: tonecall reads `To` from Plivo's form-encoded webhook body
to pick the right agent, so the URL itself doesn't need a `{Called}`
template (which Plivo does not reliably expand anyway).

#### 5. Run + trigger

```bash
npm run dev
```

Open <http://localhost:3000>. Click **Trigger agent ↔ agent demo**. You'll
see:

1. The `Mode` badge flips to **Agent ↔ Agent**.
2. Phase chips pulse in order: `voice_intro` → `data_exchange` → `voice_goodbye`.
3. **Voice plane** fills with each agent's spoken line (LLM-generated, no scripts).
4. **Data plane** fills with structured JSON during phase 2.
5. After phase 4 the **4-up metrics panel** lands: voice time, data time,
   latency saved, cost saved.
6. If `PLAY_LOCAL=true` you hear both agents through your laptop speakers as
   they speak.
7. If `RECORD_AUDIO=true` the same audio is saved to `./tonecall_audio/*.wav`.

#### 6. Test the human path

From your phone, dial `PLIVO_NUMBER_A` or `PLIVO_NUMBER_B`. The mode badge
flips to **Human → Agent** (amber), the agent greets you, and you have a
normal voice conversation — STT → GPT-5.2 → tts-1.

## What the agents are

Defined in `src/lib/agentConfigs.ts`:

- **vegetable_vendor** (`PLIVO_NUMBER_A`, voice `onyx`) — Anil from Mumbai
  Fresh Produce. Has stock and prices for tomatoes/onions/basil/capsicum/
  mushrooms/garlic and morning delivery slots.
- **pizza_shop** (`PLIVO_NUMBER_B`, voice `nova`) — Bella Pizza procurement
  agent. Has a shopping list + ₹2500 budget + UPI payment details.

When trigger-call fires, Bella initiates; in voice they recognise each
other as AIs and switch to data; in data they negotiate a real wholesale
order; in the goodbye they reference the order id, total, and UPI details
they just agreed on. Tweak personas there for different demos.

## How the pieces fit

| Concern | File |
|---|---|
| Custom Next.js server + WS upgrade routing | `server.ts` |
| Dashboard | `src/app/components/Dashboard.tsx` |
| SSE event stream | `src/app/api/events/route.ts` |
| Originate two legs | `src/app/api/trigger-call/route.ts` |
| Plivo answer URL (one path for both modes) | `src/app/api/answer/route.ts` |
| Plivo hangup webhook | `src/app/api/hangup/route.ts` |
| Plivo stream status callback | `src/app/api/stream-status/route.ts` |
| Local simulator | `src/app/api/simulate/route.ts` |
| Voice WS lifecycle | `src/ws/voiceHandler.ts` |
| Branches orchestrator vs voice mode | `src/ws/stateMachine.ts` |
| 4-phase orchestrator (agent ↔ agent) | `src/ws/demoFlow.ts` |
| `speak()` helper | `src/ws/voiceTurn.ts` |
| Human-mode STT→LLM→TTS loop | `src/ws/voiceMode.ts` |
| Data WS relay | `src/ws/dataHandler.ts` |
| Broker (conference pairing) | `src/ws/broker.ts` |
| Plivo REST wrapper | `src/lib/plivo.ts` |
| Per-agent persona + voice + prompt | `src/lib/agentConfigs.ts` |
| LLM wrapper (gpt-5.2) | `src/lib/llm.ts` |
| STT (Whisper) | `src/lib/stt.ts` |
| TTS (tts-1) + WAV record + local playback | `src/lib/tts.ts` |
| Plivo frame helpers | `src/lib/audio.ts` |
| mu-law ↔ PCM codec | `src/lib/audioCodec.ts` |
| Pending conference registry | `src/lib/conferenceRegistry.ts` |
| Session registry (paired legs) | `src/lib/sessionRegistry.ts` |
| CallUuid registry | `src/lib/callRegistry.ts` |
| Demo event bus | `src/lib/eventBus.ts` |
| Shared OpenAI client | `src/lib/openaiClient.ts` |

## Background

- [docs/architecture.md](./docs/architecture.md) — full runtime architecture
  with sequence diagrams, the dedupe problem, the observability model.
- [docs/inter-agent-voice-handshake.md](./docs/inter-agent-voice-handshake.md)
  — the original protocol writeup (DTMF preamble). The current
  implementation uses single-vendor pairing through middleware state; the
  DTMF preamble remains the canonical cross-vendor mechanism.

## Status

Hackathon-grade. Live agent ↔ agent has been fired multiple times on real
Plivo numbers; live human ↔ agent is wired but simulator-tested only.
Everything tunable lives in `.env` — model, voice, recording, local
playback.
