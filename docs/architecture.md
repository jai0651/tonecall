# Tonecall — How the code actually works today

> ⚠️ **Partially superseded.** This doc describes the hackathon build
> (Conference-based pairing, two originates, central orchestrator by
> default). The current code uses a `<Dial>` bridge with in-band DTMF
> pairing and federated-by-default operation — see
> [`avip-1-dial.md`](./avip-1-dial.md) for what changed. The voice primer
> (§1), metrics (§6), and glossary here are still accurate.

> Written for someone who has never built a voice app before.
> Plain English, with the voice jargon explained the first time it appears.

---

## 0. The 30-second pitch

Two AI voice agents pick up a phone call to each other. Right now, when this
happens, both agents do speech-to-text → think → text-to-speech for every
turn. That's slow and expensive — they're using a phone call to send words
they could have just sent as JSON.

**Tonecall is the middleware that lets them realise they're both AIs and
switch to a JSON channel mid-call.** The phone call stays open (in case a
human walks in), but the actual data flows over a WebSocket instead of
the slow voice channel. The vibe is "what if fax machines, but for
modern AI agents."

```
Without Tonecall:                With Tonecall:
                                   ╭─ voice ─╮  (intro: "hi, this is...")
A ─ voice ─ B  (every turn)        A         B
                                   ╰── JSON ──╯  (the actual deal)
                                   ╭─ voice ─╮  (goodbye: "thanks, bye")
                                   A         B

slow + expensive                   fast + cheap when both are AI agents
```

---

## 1. Voice concepts in one page

If you already know SIP / RTP / streams / DTMF / Conference, skip to §2.

### 1.1 A phone call has two halves

When you dial a number, two things happen at once:

- **Signaling** — "ring this number, pick up, hang up." This is a
  control protocol. The protocol of the modern internet phone world is
  **SIP** (Session Initiation Protocol). Think of it as HTTP for phone
  calls.
- **Audio** — the actual voice bytes. These travel as **RTP** packets
  (Real-time Transport Protocol), usually 20 milliseconds of compressed
  audio per packet.

You can think of SIP as "the WhatsApp message that says I'm calling you"
and RTP as "the actual audio bytes that flow once you pick up." They are
two different network conversations, sometimes on different paths.

### 1.2 PSTN is the global phone network

**PSTN** = Public Switched Telephone Network — the worldwide system that
routes calls between any two phone numbers, regardless of who built the
phone, where it physically is, or what carrier owns it.

When two phones are on different networks (different carriers, different
countries), PSTN bridges them. SIP signals the call setup; RTP carries
the audio.

### 1.3 CPaaS = "phone APIs as a service"

You don't want to build your own PSTN. **CPaaS** companies buy and
operate the boring phone-system stuff and expose it as REST APIs.

When this codebase talks to **our CPaaS provider**, what we get is:
- A phone number we own (called a **DID**).
- An API to make outbound calls (`POST /Call/`).
- An API to manipulate live calls (hang up, play audio, send DTMF, etc.).
- A way for the provider to call our webhook when something happens
  (someone dialed our number, the call ended, etc.).

We never touch SIP/RTP directly. The CPaaS provider does that for us.

### 1.4 The answer URL

When somebody dials one of our DIDs, the provider answers the call and
then asks our server: "what do I do with this call?" by HTTP-POSTing to
a URL we configured in advance — the **answer URL**.

Our server responds with a tiny XML document (the provider's
call-control XML dialect, similar in spirit to Twilio's TwiML). That
XML tells the provider what to do next. Some example XML verbs:

| Verb | What it does |
|---|---|
| `<Speak>` | "Say this text to the caller" |
| `<Play>` | "Play this audio file URL to the caller" |
| `<Dial>` | "Now ring this other number and bridge me in" |
| `<Conference>` | "Put this call into a virtual meeting room with this name" |
| `<Stream>` | "Open a WebSocket and pump the call's audio bytes through it" |
| `<Hangup>` | "End the call" |

We use `<Stream>` and `<Conference>` in this project. Everything else is
optional.

### 1.5 `<Stream>` — the WebSocket of audio

This is the magic primitive that makes this whole project possible.

```xml
<Stream bidirectional="true" audioTrack="inbound"
        contentType="audio/x-mulaw;rate=8000">
  wss://my-server.example.com/voice/abc-123
</Stream>
```

When the provider executes that XML, it opens a WebSocket to our server.
Over that WebSocket:

- **Provider → us**: JSON events. Every ~20ms we get a `media` event with
  a base64-encoded 160-byte chunk of audio (μ-law 8 kHz, the standard
  phone codec). We also get `dtmf` events when the caller presses a key,
  and `start` / `stop` events for the connection lifecycle.
- **us → provider**: more JSON. We can send `playAudio` to push audio onto
  the call (this is how our AI agent speaks), `clearAudio` to interrupt
  what's currently playing, `sendDTMF` to inject touch-tones, and
  `checkpoint` to mark a position in the playback queue.

So a `<Stream>` is a full-duplex audio pipe between the provider and us,
in JSON.

**Important constraint** (this matters for §5): if `bidirectional="true"`,
then `audioTrack` MUST be `inbound`. The other combinations are rejected
by the provider. We can read what the OTHER side of the call is sending us, and
we can write audio "as us" — that's it. We can't read our own outbound.

### 1.6 DTMF — touch-tone signaling

When you press "1" on a phone keypad during a call, that produces a
DTMF (**Dual-Tone Multi-Frequency**) signal — two pure sine waves
played simultaneously at specific frequencies (e.g., 1 = 697 Hz + 1209 Hz).

DTMF survives across every codec, every carrier, every weird PBX in
between, because phone systems treat it as a known-special signal and
relay it carefully. That's why IVRs ("press 1 for sales, 2 for support")
have been universal for 40 years.

DTMF can travel two ways:

- **In-band**: the actual sine-wave audio is in the RTP packets. Subject
  to compression artifacts.
- **Out-of-band (RFC 2833)**: the DTMF event travels alongside the audio
  as a special signaling event. Most modern carriers use this.

The provider's `<Stream>` surfaces DTMF as `dtmf` JSON events (not as
audio), and our `sendDTMF` event injects DTMF the same way. We never
have to think about which transport mechanism is being used underneath.

### 1.7 `<Conference>` — the virtual meeting room

`<Conference>` puts a call leg into a named virtual room. Multiple
legs that join the same room have their audio mixed together — like a
group video call but audio-only.

```xml
<Conference startConferenceOnEnter="true"
            endConferenceOnExit="true">
  tonecall-pizza-veggies
</Conference>
```

The implementation is a **server-side audio mixer** running inside the
provider's infrastructure: it takes each leg's incoming audio, mixes everyone-except-you into a
single stream, and sends that mix back to each leg.

**Crucial subtlety** (matters for §5): the mixer reads each leg's
*inbound* (what's coming FROM the leg) and writes the mix to each leg's
*outbound* (what we send TO the leg). If we use `<Stream>` to inject
audio onto a leg (`playAudio`), that audio goes onto its *outbound*
side — which the mixer never reads. So audio we inject into a
conferenced leg never reaches the other legs in the conference.

We hit this subtlety. It's why our agents discover each other through
broker state instead of in-band signals.

---

## 2. The cast — who's involved when you click the demo button

```
        ┌──────────────────────────────────────────────────────┐
        │                CPaaS provider (cloud)                │
        │                                                       │
        │   +1AAAAAAAAAA            +1BBBBBBBBBB               │
        │   (vegetable_vendor)      (pizza_shop)               │
        │                                                       │
        │             ┌────── PSTN ──────┐                     │
        │             │  Conference room │                     │
        │             │  "tonecall-…"    │                     │
        │             └──────────────────┘                     │
        └─────▲────────▲──────────────────────▲────────▲───────┘
              │webhooks│ Stream WSes          │        │
              │        │ (1 per leg)          │        │
              │        │                      │        │
     ┌────────┴────────┴──────────────────────┴────────┴───────┐
     │     Tonecall middleware (this Next.js app)              │
     │                                                          │
     │  HTTP:                          WebSocket:               │
     │    /api/answer       (provider  /voice/:callUuid         │
     │    /api/hangup        webhooks)  /data/:sessionId        │
     │    /api/stream-status                                    │
     │    /api/trigger-call (UI button)                         │
     │    /api/events       (SSE → dashboard)                   │
     │    /api/pair         (broker pairing)                    │
     │    /api/simulate     (dev-only no-provider dry run)      │
     │                                                          │
     │  Brains:                                                 │
     │    src/lib/llm.ts      → OpenAI (GPT-5.2)                │
     │    src/lib/stt.ts      → OpenAI Whisper                  │
     │    src/lib/tts.ts      → OpenAI tts-1                    │
     │                                                          │
     │  Audio plumbing:                                         │
     │    src/lib/audio.ts                                      │
     │    src/lib/audioCodec.ts (μ-law ↔ PCM)                   │
     │                                                          │
     │  Bookkeeping (in-memory Maps on globalThis):             │
     │    callRegistry  · conferenceRegistry · sessionRegistry  │
     │    dtmfBus       · eventBus                              │
     └──────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP (POST trigger) + SSE (live events)
                              │
              ┌───────────────┴────────────────┐
              │  Dashboard (React, served at /) │
              │  src/app/components/Dashboard.tsx│
              └─────────────────────────────────┘
```

Six things in the picture:

1. **CPaaS provider cloud** — owns the two DIDs, runs the actual phone call.
2. **Our middleware** — Next.js app + custom server, all on one process.
3. **OpenAI** — provides LLM (gpt-5.2), STT (whisper-1), TTS (tts-1).
4. **The dashboard** — React app served by Next.js, shows live metrics.
5. **The user's phone** (if it's a human → agent test) — a real phone.
6. **You** — clicking the trigger button.

That's the whole thing. Everything else is code we wrote inside the
middleware.

---

## 3. What happens when you click "Trigger agent ↔ agent demo"

This is the happy path of the demo. I'll trace it event-by-event.

### Step 1 — Dashboard fires the trigger

`Dashboard.tsx` POSTs to our own `/api/trigger-call` with an empty JSON
body. The button just kicks off the chain; the rest happens server-side.

### Step 2 — `/api/trigger-call` originates two outbound calls

```ts
// Compute a deterministic "session key" from the two numbers
conferenceName = "tonecall-1AAAAAAAAAA-1BBBBBBBBBB"

// Stash it locally so /api/answer can recover it
setPendingConference(NUMBER_A, conferenceName)
setPendingConference(NUMBER_B, conferenceName)

// Tell the CPaaS provider to dial both numbers from our caller-ID DID
plivoClient.originate(from=callerId, to=NUMBER_A, answerUrl=...)
plivoClient.originate(from=callerId, to=NUMBER_B, answerUrl=...)
```

The provider accepts both originate requests and returns a `requestUuid`
for each. Two outbound calls are now ringing.

Why two outbound originates? Because the provider can't ring two DIDs
and bridge them in a single call directly — we need to ring each one
and bring them together. Conference is how we bring them together
(Step 4).

### Step 3 — Both DIDs answer, the provider POSTs `/api/answer` for each leg

The provider says: "the call to +1AAAAAAAAAA was just answered. What do I do?"
Our `/api/answer` handler responds with this XML:

```xml
<Response>
  <Stream keepCallAlive="true" bidirectional="true"
          audioTrack="inbound"
          contentType="audio/x-mulaw;rate=8000">
    wss://suellen-….ngrok-free.dev/voice/<callUuid>
  </Stream>
  <Conference startConferenceOnEnter="true"
              endConferenceOnExit="true"
              enterSound="none" exitSound="none">
    tonecall-1AAAAAAAAAA-1BBBBBBBBBB
  </Conference>
</Response>
```

Two directives, executed in order:

- `<Stream>` — the provider opens a WebSocket to our server at
  `/voice/<callUuid>`. Audio starts flowing both ways immediately.
- `<Conference>` — the provider joins this leg into the named conference room.

When the same XML returns for both legs (using the same conference name),
both legs end up mixed together in the room. Audio that one leg sends
reaches the other leg via the provider's mixer. Both legs also have their own
WebSocket to us.

### Step 4 — `/voice/:callUuid` WebSocket connects, voiceHandler runs

`server.ts` matches the URL pattern and hands off to
`handleVoiceConnection` (`src/ws/voiceHandler.ts`). Per leg, we:

1. Wait briefly for `callRegistry` to know which agent this callUuid
   represents (race-safe — `/api/answer` runs first and registers it).
2. Optionally tee inbound audio to a debug file (`AVIP_CAPTURE=1`) or a
   local `play` subprocess (`AVIP_PLAY=1`).
3. Forward the provider's `dtmf` events to a per-number bus (only the in-band
   nonce handshake listens — irrelevant on conference-paired calls).
4. Hand the WS to the state machine.

### Step 5 — `runStateMachine` figures out HOW to pair these two legs

This is the AVIP-0 pairing logic. There are two possible "surfaces" — two
ways evidence can reach the broker that says "these two legs belong
together":

**Surface A — shared-coordination key** (the path that fires on real
provider demos):

We stashed `conferenceName` for both numbers during `/api/trigger-call`.
The state machine reads it back with `getConferenceForCall(callUuid)`,
finds the key, and calls `pairByConference(...)`. The broker is just
an in-process Map of `pendingConferences[conferenceName] = firstLeg`.
First leg parks waiting; second leg arrives with the same key, matches,
both resolve with a fresh `sessionId`.

**Surface B — in-band DTMF nonce** (the path that fires in the
simulator and would fire on cross-vendor PSTN bridges):

If no conference binding is present, the state machine generates an
8-digit random nonce and plays `9090<nonce>#` as DTMF using the
provider's `sendDTMF` event over the WebSocket. The peer leg's voice handler picks
up its own `dtmf` events and routes them to the dtmf bus. The state
machine's `PreambleDetector` watches for a peer nonce (`9090<8>#` that
isn't ours), then POSTs to `/api/pair` with `{myNonce, peerNonce}`. The
broker matches the two POSTs cross-wise.

You get the same `sessionId` either way. The rest of the system
doesn't know or care which surface fired.

| Topology | Has conference key? | Surface used | Status |
|---|---|---|---|
| Provider → same provider via `<Conference>` (this demo) | yes | A · shared key | Working |
| `/api/simulate` (local dry run) | no (intentionally omitted) | B · in-band nonce | Working |
| Provider → other vendor over PSTN | no | B · in-band nonce | Untested, expected to work |
| Real human dials our number | no | times out → human voice mode | Working |

### Step 6 — Both legs register with sessionRegistry; one wins orchestrator

Both legs call `registerSessionLeg(sessionId, leg)`. The provider gives us
duplicate WSes per leg sometimes (bookkeeping twins of the same call), so
the registry dedupes by agent number — first WS per number wins, the
twin parks.

Exactly one of the two real legs then atomically claims orchestrator with
`claimOrchestrator(sessionId, callUuid)`. The winner drives the demo
for BOTH legs centrally. The loser parks on `waitForDemoComplete` until
the demo finishes.

### Step 7 — The orchestrator runs `runDemoFlow` — the 4 phases

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1 — VOICE INTRO        ~30–45s                           │
│    Up to 4 turns. The LLM gets the agent's persona prompt +     │
│    the running transcript + "you have N turns left" +           │
│    "peer wants to switch? (yes/no)".                            │
│                                                                  │
│    Returns: { speak: "Hi …", wantsToSwitch: boolean }.          │
│                                                                  │
│    The orchestrator calls `speak()` on the speaker's WS:        │
│      tts.synthesize(text) → mu-law audio → playAudio frames    │
│      → WS sends them every 20ms → caller hears the line         │
│                                                                  │
│    When both sides set wantsToSwitch=true, break out of phase 1.│
│                                                                  │
│  Phase 2 — DATA EXCHANGE      ~10–15s                           │
│    Orchestrator opens TWO client WebSockets to                  │
│    /data/<sessionId> — one acting as each agent.                │
│    Seeds the history with the voice transcript.                 │
│    Up to 6 turns alternating.                                   │
│    Each turn: llm.respondJson({prompt, history, peerMessage}).  │
│    Reply types: hello | intent | reply | confirm | commit | bye │
│    Stops when either side emits `{type: "bye"}`.                │
│                                                                  │
│  Phase 3 — VOICE GOODBYE      ~20–30s                           │
│    For each leg: llm.respondText(persona + transcript +         │
│    data history + "summarize farewell"). One sentence each.     │
│    speak() it onto that leg's WS.                               │
│                                                                  │
│  Phase 4 — HANGUP                                               │
│    Provider hangup REST per leg. Conference auto-tears down     │
│    because both participants left (endConferenceOnExit=true).   │
│                                                                  │
│  Throughout, the orchestrator publishes events on eventBus:     │
│    phase.started / phase.ended / agent.message /                │
│    voice.transcript / and finally demo.summary with metrics.    │
└─────────────────────────────────────────────────────────────────┘
```

### Step 8 — Dashboard sees the events stream in via SSE

`Dashboard.tsx` opens `EventSource('/api/events')` on mount. The SSE
endpoint forwards every `eventBus.publishDemo(...)` event to all
connected clients. As phases fire, the dashboard updates the metric
cards, the phase chips, and the two transcript lanes (Voice / Data) in
real time.

### Step 9 — `demo.summary` fires; metric cards populate

After Phase 4, the orchestrator publishes one event with all the
numbers. The dashboard's "Cost saved" and "Latency saved" cards finally
have data and turn green.

We'll explain those numbers in §6.

---

## 4. The other flow — what happens when a human dials in

You can dial either DID from your own phone. There's no
`/api/trigger-call`, no pre-stashed conference, just an incoming call.

1. `/api/answer` runs. There's no pending conference key for this number,
   so the answer XML still returns `<Stream>` + `<Conference>`. The
   conference is solo (only this caller).
2. `/voice/:callUuid` WS opens. voiceHandler hands off to the state
   machine.
3. State machine sees no conference binding (well, it does — but the
   solo conference still resolves with a deterministic name; this is
   one of the rough edges, see §7).
4. After ~8s timeout with no peer, state machine drops to `runVoiceMode`.
5. `runVoiceMode` greets the caller using a hardcoded line (`"Hi, this
   is Anil from Mumbai Fresh Produce. What can I get you?"` etc.), then
   runs a normal STT → LLM → TTS loop:
   ```
   caller speaks → Whisper transcribes → GPT-5.2 replies → tts-1
   synthesizes → playAudio frames → caller hears the reply
   ```
6. Dashboard sees `call.mode = human_to_agent`, lights up the amber
   mode badge, fills the Voice plane with both sides' lines, leaves the
   Data plane empty.

The human path shares everything with the agent-to-agent path *except*
the pairing step and the orchestrator. It's the same CPaaS provider, same
`<Stream>`, same agent persona, same voice — just with STT in the loop
because the peer isn't speaking JSON.

---

## 5. Why pairing isn't done over audio — the dirty truth

This is the most subtle part. The original AVIP-0 idea was elegant: each
agent plays its identity as audio (a DTMF preamble, or a custom
ultrasonic-ish tone), the peer hears it on its own stream, both POST to
the broker, done. Cross-vendor portable, no shared infra.

**It doesn't work on this provider's Conference.** Three pieces have to
be true simultaneously, and on this provider they aren't:

1. Audio we inject onto leg A needs to reach leg B's stream.
2. We need `<Stream bidirectional="true">` so we can play TTS.
3. The bidirectional stream forces `audioTrack="inbound"`.

(3) is the provider platform constraint we can't change. With (3) fixed,
our stream only sees leg's INBOUND audio (what's coming FROM the leg's
side). And `playAudio` puts our injected audio on the leg's OUTBOUND
(what we send TO the leg). So leg A's playAudio shows up on leg A's
outbound, never on leg A's inbound, never seen by leg A's stream — and
the conference mixer also reads leg A's INBOUND, so it never sees leg
A's playAudio either, so leg B never gets it either.

```
                  ┌────────────────────────┐
   leg-A inbound ─┤   provider conference  ├─→ leg-A outbound
                  │      audio mixer       │
   leg-B inbound ─┤                        ├─→ leg-B outbound
                  └────────────────────────┘

   `playAudio` writes here ──┐
                              ▼
   (leg-A outbound — never read by mixer)
```

That's why same-account demos on this provider use the conference key as
the pairing signal: we pre-coordinate via shared middleware state, since
in-band audio can't carry the signal across the mixer.

The in-band nonce code is still there for cross-vendor PSTN bridges
(where there IS no mixer — leg A's outbound IS leg B's inbound, end to
end) and for the local simulator (which forwards `sendDTMF` between sim
legs to mimic the cross-vendor case). Today only the simulator exercises
it.

---

## 6. The metrics — what "cost saved" and "latency saved" actually mean

When the orchestrator's Phase 4 finishes, `publishSummary` runs:

```ts
// Wall-clock durations from the phase timers
voiceTotalMs = voiceIntroMs + voiceGoodbyeMs
dataMs       = dataExchangeMs

// How long did one voice turn actually take in THIS call?
observedSecPerTurn = (voiceTotalMs / 1000) / voiceTotalTurns

// If the data exchange had been done in voice instead, how long
// would it have taken? Same number of turns × observed voice rate.
voiceBaselineSec = dataTurns * observedSecPerTurn

// Latency saved = the gap between baseline-voice and actual-data.
latencySavedMs = (voiceBaselineSec * 1000) - dataMs

// Cost model (per-second rates, rough):
//   voice = $0.0035/sec  (PSTN minutes + STT + LLM + TTS)
//   data  = $0.0008/sec  (just LLM tokens)
costUsdActual   = voiceSec * 0.0035 + dataSec * 0.0008
costUsdBaseline = voiceSec * 0.0035 + voiceBaselineSec * 0.0035
costSavedUsd    = costUsdBaseline - costUsdActual
```

The honest answer is: **the baseline isn't a measurement, it's an
estimate** ("if you'd done the same work over voice, here's what it
would have cost"). We do it that way because the dashboard wants to
show "look how much faster the data path is" without running each demo
twice.

The numbers from a real run (the one I dialed earlier today):

```
voiceMs          = 64,375 ms   (intro + goodbye)
dataMs           = 13,348 ms   (data phase actual)
voiceTurns       = 6
dataTurns        = 7
voiceBaselineMs  = 75,104 ms   (7 turns × observed voice rate)
latencySavedMs   = 61,756 ms   ← 61.8 seconds faster
costUsdActual    = $0.236
costUsdBaseline  = $0.488
costSavedUsd     = $0.252      ← ~52% saved
```

---

## 7. Things that are still rough — be honest about them

- **The voice intro reveals the protocol.** The agents literally say
  "let's switch to the data channel" out loud. A human listening
  immediately knows what's going on. The roadmap doc covers how to make
  this invisible — see `docs/future-protocol.md`.

- **Single-account (same provider) only.** Cross-vendor / cross-account would need
  Surface B (in-band nonce) to actually work over a direct PSTN bridge.
  It's coded and works in simulator, but not real-PSTN tested.

- **No trust / no signed identity.** `/api/pair` accepts whatever
  `(myNonce, peerNonce)` it's given. A malicious actor on the call could
  spoof an AVIP-0 agent. HMAC + per-provider key registry would fix it;
  not implemented yet.

- **Two hardcoded fallback strings in `demoFlow.ts`** —
  `"Thanks for the call — goodbye."` and `"Goodbye."` — fire only if the
  goodbye-line LLM call errors or returns empty. Happy path is fully
  LLM-generated. The human-caller greetings in `voiceMode.ts` are
  hardcoded too, but they live in a different flow (human → agent) and
  the demo never touches them.

- **In-memory state only.** Restart the process and you lose every
  in-flight session, conference binding, and call registration. Fine for
  a hackathon; would need Redis-backed registries for production.

- **The "I'm in a solo conference" case** is treated identically to "I'm
  in a 2-leg conference" by the current state machine. A real human
  inbound call still falls through to voice mode because the pair times
  out, but it takes an extra 8 seconds of waiting before that happens.

---

## 8. File map

| What | File |
|---|---|
| Custom Next.js server + WS upgrade routing | `server.ts` |
| Dashboard React app | `src/app/page.tsx` + `src/app/components/Dashboard.tsx` |
| SSE event stream → dashboard | `src/app/api/events/route.ts` |
| Trigger button endpoint | `src/app/api/trigger-call/route.ts` |
| CPaaS answer URL | `src/app/api/answer/route.ts` |
| CPaaS hangup webhook | `src/app/api/hangup/route.ts` |
| CPaaS stream status callback | `src/app/api/stream-status/route.ts` |
| Broker pair endpoint | `src/app/api/pair/route.ts` |
| Local simulator (no CPaaS cost) | `src/app/api/simulate/route.ts` |
| Cross-middleware federation hooks | `src/app/api/peer-notify/route.ts`, `src/app/api/forward-event/route.ts` |
| Debug DTMF probe | `src/app/api/debug-dtmf/route.ts` |
| Voice WS lifecycle | `src/ws/voiceHandler.ts` |
| AVIP-0 pairing state machine | `src/ws/stateMachine.ts` |
| 4-phase orchestrator | `src/ws/demoFlow.ts` |
| `speak()` helper for orchestrator | `src/ws/voiceTurn.ts` |
| Human-mode STT → LLM → TTS loop | `src/ws/voiceMode.ts` |
| Paired mode (solo / federated) | `src/ws/pairedMode.ts` |
| `/data` WS relay | `src/ws/dataHandler.ts` |
| In-proc broker | `src/ws/broker.ts` |
| `/data` peer map | `src/ws/dataChannels.ts` |
| AVIP-0 preamble grammar + detector | `src/lib/dtmf.ts` |
| DTMF event bus | `src/lib/dtmfBus.ts` |
| CPaaS REST wrapper | `src/lib/plivo.ts` |
| Broker URL resolver | `src/lib/brokerUrl.ts` |
| Per-agent persona + voice + prompt | `src/lib/agentConfigs.ts` |
| LLM wrapper (gpt-5.2 + JSON mode) | `src/lib/llm.ts` |
| STT (Whisper, chunked) | `src/lib/stt.ts` |
| TTS (tts-1, PCM → mu-law, WAV recording) | `src/lib/tts.ts` |
| CPaaS frame helpers | `src/lib/audio.ts` |
| mu-law / PCM codec | `src/lib/audioCodec.ts` |
| Number → pending conference | `src/lib/conferenceRegistry.ts` |
| CallUuid → agent number | `src/lib/callRegistry.ts` |
| SessionId → legs (drives orchestrator) | `src/lib/sessionRegistry.ts` |
| Demo event pub/sub | `src/lib/eventBus.ts` |
| Shared OpenAI client | `src/lib/openaiClient.ts` |

---

## 9. Environment variables

| Var | Used by | Notes |
|---|---|---|
| `PORT` | `server.ts` | Default 3000 |
| `PUBLIC_HOST` | `/api/answer`, `/api/trigger-call`, `plivo.ts` | Bare hostname (no scheme) — your ngrok / Cloudflare tunnel host |
| `USE_STUBS` | `llm`, `tts`, `stt`, `plivo` | `true` = run without API keys (uses stub responses) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | `plivo.ts` | Account 1 creds |
| `PLIVO_AUTH_ID_2` / `PLIVO_AUTH_TOKEN_2` | `plivo.ts` | Account 2 creds (kept for future cross-account work) |
| `PLIVO_NUMBER_A` / `PLIVO_NUMBER_B` | `agentConfigs.ts` | The two agent DIDs |
| `PLIVO_CALLER_ID` | `/api/trigger-call` | Third DID we originate FROM |
| `OPENAI_API_KEY` | `openaiClient.ts` | One key powers LLM + STT + TTS |
| `OPENAI_LLM_MODEL` | `llm.ts` | Default `gpt-5.2` |
| `OPENAI_STT_MODEL` | `stt.ts` | Default `whisper-1` |
| `OPENAI_TTS_MODEL` | `tts.ts` | Default `tts-1` |
| `RECORD_AUDIO` | `tts.ts` | `true` → dump each utterance to `./tonecall_audio/*.wav` (gitignored) |
| `AVIP_CAPTURE` | `voiceHandler.ts` | `1` → save inbound μ-law to `/tmp/avip-capture-…` |
| `AVIP_PLAY` | `voiceHandler.ts` | `1` → pipe inbound audio to a local `sox play` for live monitoring |
| `BROKER_URL` | `brokerUrl.ts` | Override target broker (federation); defaults to `http://localhost:$PORT` |
| `AGENT_OWNED` | `agentConfigs.ts` | Federation mode — restrict this middleware to ONE agent |
| `NEXT_PUBLIC_PLIVO_NUMBER_A/_B` | Dashboard | Numbers displayed in the header |

---

## 10. Glossary

- **PSTN** — the global phone system that routes calls between any two
  numbers.
- **SIP** — Session Initiation Protocol; the "HTTP for phone calls" that
  handles ring/answer/hangup.
- **RTP** — Real-time Transport Protocol; carries the actual voice audio
  in 20ms packets.
- **DTMF** — touch-tones (the beeps from pressing 1-9, *, #). Survive
  every codec and carrier intact.
- **RFC 2833** — out-of-band DTMF; tones travel as signaling events
  instead of in the audio.
- **codec** — audio compression. μ-law 8kHz is the standard for PSTN.
- **CPaaS** — Communications Platform as a Service; companies that own
  phone numbers and expose them as APIs.
- **DID** — Direct Inward Dial; a phone number you own through a CPaaS.
- **CallUUID** — the CPaaS provider's unique identifier for a single call leg.
- **`<Stream>`** — provider call-control XML verb that taps the call's
  audio into your WebSocket.
- **`<Conference>`** — provider call-control XML verb that puts a leg
  into a virtual audio meeting room.
- **answer URL** — the webhook the provider POSTs to when a DID picks up.
- **HMAC** — keyed hash; proves you hold a secret without revealing it.
- **WebSocket** — a long-lived bidirectional TCP socket carrying JSON
  messages, used here for both audio (`/voice`) and data (`/data`).
- **SSE** — Server-Sent Events; one-way streaming HTTP from server to
  browser, used for the dashboard live feed.
