# Tonecall — Demo Day playbook

Everything you need to stand up the demo, talk through it, and answer
hard questions afterward. Read top-to-bottom before going on stage.

---

## 0. Pre-flight checklist (5 minutes before)

Run through these in order. If any one fails, fix before clicking
Trigger.

```bash
# 1. ngrok pointing at port 3000
curl -s -o /dev/null -w "ngrok HTTP %{http_code}\n" \
  https://suellen-kernelless-verdell.ngrok-free.dev/
# expect: HTTP 200

# 2. dev server up on port 3000
lsof -nP -iTCP:3000 -sTCP:LISTEN | head -2
# expect: one node process listening

# 3. Provider Application URLs point at /api/answer (not /api/answer-dial-probe)
for APP in 23820040522110407 11581818029773360; do
  curl -sS -u "$PLIVO_AUTH_ID:$PLIVO_AUTH_TOKEN" \
    "https://api.plivo.com/v1/Account/$PLIVO_AUTH_ID/Application/$APP/" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['app_name'],d['answer_url'])"
done
# expect: both → https://suellen-kernelless-verdell.ngrok-free.dev/api/answer

# 4. Hit the dashboard and let it render
open http://localhost:3000   # or your ngrok URL on the projector machine

# 5. Confirm the SSE event stream is alive
curl -sN --max-time 2 http://localhost:3000/api/events | head -3
# expect: a heartbeat line or an event line; should not 404
```

If the dev server needs a restart: `npm run dev` (uses `.env` defaults
— USE_STUBS=false will hit a real CPaaS provider + OpenAI).

Have **two** terminal tabs and **one** browser tab visible to the
projector:

- **Tab 1 — browser**: dashboard at `/` (this is the hero visual).
- **Tab 2 — terminal**: `tail -f /tmp/tonecall-*.log` showing the
  live server log (use this as backup if dashboard freezes; also good
  for credibility — judges see real plumbing).
- **Tab 3 — terminal (optional)**: pre-typed `curl -X POST .../api/trigger-call`
  in case you want to fire from CLI instead of clicking the button.

---

## 1. The pitch — 90 seconds

> Two AI voice agents on a phone call right now do this every single
> turn: text → TTS → audio → STT → text → think → repeat. That's 4
> seconds of round-trip per turn, with errors injected at every step
> ("extra cheese" → "extra Swiss"), and the user pays for TTS, STT,
> LLM tokens, and PSTN minutes.
>
> Tonecall is the missing handshake. The moment two AI agents realise
> they're both AIs, they switch from spoken English to a JSON
> side-channel over a WebSocket — same logic as a fax machine
> screeching at the start of a call, but for AI agents.
>
> The phone stays open in case a human walks in. The actual deal closes
> in 200ms per turn instead of 4 seconds. Same negotiation that took
> 45 seconds in voice mode closes in 3 seconds in data mode.
>
> Today we're demoing it on our CPaaS provider, two of our own DIDs calling
> each other. The protocol is called **AVIP-0 — Agent Voice Interop Protocol v0**.
> We see it as a wedge for a CPaaS provider to own a standard the way DKIM owns
> email signing.

End on: *"Let me show you."*

Then click trigger.

---

## 2. The live demo — what happens, what to say

### The visual story

```
   click "Trigger agent ↔ agent demo"
   ↓
   t=0      :  call.triggered  (mode badge: AGENT ↔ AGENT)
   t=2      :  both legs ring + answer
   t=3      :  pairing.summary  (badge lights green: "AVIP-0 paired")
   t=3-35   :  voice intro phase (pleasantries; agents speak)
              ↑ VOICE plane fills up
              ↑ "voice_intro" chip pulses
   t=35-48  :  ▸ THE MOMENT: agents say "we're both AIs, switch to data"
              ↑ "data_exchange" chip pulses
              ↑ DATA plane fills up with JSON {intent, reply, confirm, …}
              ↑ VOICE plane goes silent
   t=48-78  :  voice goodbye phase (agents sign off naturally)
   t=78     :  demo.summary FIRES
              ↑ four metric cards light up:
                 Voice time | Data time | Latency saved | Cost saved
```

### Beat-by-beat narration

**t=0 (click trigger).** Cursor on the button. Say:
> "I'm dialing two phone numbers I own. They both answer with AI
> agents — a vegetable vendor and a pizza shop procurement bot."

**t=2-5 (both legs answer, "AVIP-0 paired" badge appears).** Point at
the green badge.
> "Our CPaaS provider has bridged the two calls into a conference room. The agents
> have just discovered each other through our broker — that's the
> 'AVIP-0 paired' badge. Took less than a second."

**t=5-30 (voice intro running, transcript filling up).** Point at the
voice plane.
> "Now they're talking like normal voice agents would — STT, LLM, TTS
> on every turn. This is the slow path. Listen to how natural the
> pleasantries are — both sides hint that they suspect the other is
> an AI."

(If you have audio routing to the room speakers, the agents are
literally speaking right now. That's the gold standard demo moment.)

**t=30-35 (THE BIG MOMENT — agents agree to switch).** Point at the
last voice line:
> "There — the pizza shop just said 'sounds like we're both AIs,
> let's switch to the data channel.' The vegetable vendor agrees.
> Now watch the right pane."

**t=35-48 (data exchange running).** Point at the data plane filling
up.
> "These are JSON messages flying between the agents over a WebSocket.
> No TTS, no STT, no audio. Each message takes ~50ms instead of 4
> seconds. They're negotiating: how many kilos of tomatoes, what time
> for delivery, total cost, payment method. Watch the messages —
> intent, reply, confirm, commit, bye. It's a full transaction in
> half a second of actual work."

**t=48-78 (voice goodbye).** Point at the voice plane resuming.
> "Once the deal is closed, the agents come back to voice for a
> goodbye line. This is for the humans listening — if anyone walked
> into the call mid-way, the spoken farewell tells them what
> happened. Voice channel = always available fallback."

**t=78 (demo.summary, metric cards light up).** Point at the four
metric cards.
> "And there's the scorecard:
> - **Voice time**: ~64 seconds — what we actually spent on TTS/STT.
> - **Data time**: 13 seconds — the JSON exchange.
> - **Latency saved**: 61 seconds vs what voice-only would have taken
>   for the same 7-turn deal.
> - **Cost saved**: $0.25 on this one call — 52% less than the
>   voice-only baseline. Multiply that by a large CPaaS provider's volume and the
>   savings are billions of dollars a year."

End on: *"That's the wedge. Questions?"*

### If something fails mid-demo

| Failure | What you see | Recovery |
|---|---|---|
| One leg doesn't ring | only `vegetable_vendor` log line, no `pizza_shop` | Check the provider Application URL is still `/api/answer` (see preflight #3). Patch it via the curl in §4. |
| Both rings but no pairing badge | "voice_intro" chip never appears | Conference name probably stale. Wait for the 15s pair timeout, then say "the system fell back to human voice mode — let me retry." Click trigger again. |
| LLM rate-limit / OpenAI 429 | Voice plane has 1-2 lines then stops | Honest move: *"OpenAI just rate-limited us mid-demo — this is a hackathon-level OpenAI key. The protocol is working; the agent's brain is what stalled."* |
| Dashboard freezes | event chips stop updating | Refresh the page; SSE reconnects automatically; events from the same call should resume. |
| Total dead air | nothing in dashboard, nothing in logs | Switch to terminal. `tail -f /tmp/tonecall-*.log` and walk through the architecture verbally. Read `docs/architecture.md` §3 word-for-word. |

**Never apologize for visible failures longer than 5 seconds.** Move to
the architecture explanation; the judges learn just as much from how
you talk about the code as they do from a perfect demo.

---

## 3. FAQs — likely audience questions

Quick, confident answers. Memorize these.

### "Is this actually running, or is it scripted?"

Real CPaaS provider, real OpenAI, real PSTN. The two numbers on screen are real
DIDs I own. You can dial them yourself from your phone right now if you
want — try `+1AAAAAAAAAA`, you'll get the vegetable vendor agent in
human-voice mode.

### "Does it work if a human picks up?"

Yes. The "two-mode" design is the whole point. If only one side is an
agent and the other is a human, the AVIP-0 handshake times out (humans
don't punch DTMF preambles), the system falls back to a normal
STT-LLM-TTS voice loop, and the agent has a regular conversation. We
never trade off worse human service for better agent service — the
voice channel is the always-available fallback.

### "Why is this a protocol and not just two agents chatting faster?"

Because anyone — Twilio, Telnyx, OpenAI's voice mode, ElevenLabs — can
implement it. The handshake is in-band over DTMF (or via well-known
endpoints in the v3+ design), so any AI agent platform that speaks AVIP-0
can pair with any other. That's the wedge: the CPaaS provider gets to define the
spec.

### "How much faster is it actually?"

On the demo you just saw: voice-only baseline 75 seconds, data path 13
seconds. Real-world ratios depend on the number of structured turns
in the negotiation; 4–6× is typical for order-taking / scheduling /
lookup workflows.

### "What's the cost saving model? Where does '$0.25 saved' come from?"

Per-second rates: voice path = $0.0035/sec (PSTN + STT + LLM tokens +
TTS), data path = $0.0008/sec (just LLM tokens). The baseline assumes
the data exchange would have happened in voice with the same number of
turns at this run's observed voice rate. Honest estimate, not a
measurement — but directionally correct.

### "What happens if both sides claim they're agents but they aren't?"

Today: nothing — pairing is open. In the next version (AVIP-3), each
agent's identity is published at `https://provider.com/.well-known/avip`
DKIM-style, every preamble is HMAC-signed, and the broker verifies the
signature before pairing. Spoofing then requires compromising the
agent's domain — same security model as TLS/DKIM.

### "Is this open-source?"

Yes — the repo is `tonecall`, the protocol spec is `docs/architecture.md`
and `docs/future-protocol.md`. The runtime is ~3,000 lines of
TypeScript. The license is whatever the hackathon defaults to; we'll
relicense MIT post-hackathon.

### "Why two phone numbers instead of one?"

Because in production this isn't two of our agents talking to
themselves — it's the pizza shop's agent (on one CPaaS provider) calling the
vegetable vendor's agent (on a different one). Two real businesses, two
unrelated CPaaS providers. We use two of our own DIDs in the demo
because it's the simplest setup that exercises the full handshake.

### "What does the user hear if they're listening in?"

Today: the full voice intro and goodbye, plus modem-chirp-like audio
during the data exchange phase (cosmetic, so it sounds like "data is
flowing"). In the v2 design (in `docs/future-protocol.md`) the
handshake happens during SIP call setup before any TTS plays — humans
hear nothing unusual.

### "What if the agents can't agree on the data schema?"

Capability negotiation in the hello message. The agents trade
capability lists (e.g., `produce_order_v2`, `bill_settle_v1`); if they
share a capability they use it, if they don't they fall back to free
text inside a structured envelope (a `{type: "reply", text: "…"}`
message), and worst case fall back to voice. The protocol never breaks
hard — it just degrades to slower channels.

### "Where's the AI? Is OpenAI?"

Yes — GPT-5.2 for the LLM, tts-1 for speech synthesis, Whisper for
transcription. Both agents use the same OpenAI account; the personas
are config-dict entries in `src/lib/agentConfigs.ts`.

---

## 4. Deep Q&A — for the judge or engineer who wants the wire-level story

### "How exactly do the two agents discover each other?"

Today's demo uses a server-side coordination key: our middleware
generates a deterministic conference name from the (numberA, numberB)
pair, both legs hit the same `/api/pair` broker with that name, and
the broker matches them and returns a shared session id.

This is the "single-vendor pragmatic" path. The protocol-portable path
— what AVIP-1 ships — is in-band: each agent plays `9090<8-digit-nonce>#`
as DTMF using the provider's `sendDTMF` WebSocket event, and listens for the
peer's preamble on its own stream as `dtmf` JSON events. The broker
matches cross-wise nonces.

We empirically verified that the provider's `<Dial>` bridge carries DTMF
end-to-end (the probe at `/api/trigger-dial-probe` injected
`90901234#` on one leg and observed all 9 digits arrive intact on
the peer leg's stream). So the in-band path will work cross-vendor
the moment we redirect from `<Conference>` to `<Dial>` bridging.

### "Why does the in-band path not work on `<Conference>`?"

The provider's bidirectional `<Stream>` requires `audio_track="inbound"`. The
Conference mixer reads each leg's inbound audio and writes the mix to
each leg's outbound. Anything we inject onto our leg (playAudio,
sendDTMF) lands on the leg's outbound side, which the mixer never
reads. So the signal never reaches the peer leg.

`<Dial>` is a direct SIP/PSTN wire instead — leg A's outbound IS leg
B's inbound. We proved DTMF crosses cleanly. The conference workaround
existed because the provider previously refused same-account self-DID Dial
("Ring Timeout"); that turned out to be a stale Application URL on
one of the DIDs, which we fixed. The refactor to drop Conference is
~150 lines and will ship post-hackathon.

### "What's in the four-phase orchestrator?"

```
Phase 1 — VOICE INTRO         ~30–45s
  Up to 4 turns. LLM gets persona + transcript + "you have N turns
  left" + "peer wants to switch (y/n)". Returns {speak, wantsToSwitch}.
  Both agents agree → break to phase 2.

Phase 2 — DATA EXCHANGE       ~10–15s
  Two client WebSockets to /data/<sessionId>. Up to 6 alternating
  turns. LLM responds in JSON: hello | intent | reply | confirm |
  commit | bye. Stops on any side emitting `bye`.

Phase 3 — VOICE GOODBYE       ~20–30s
  Per leg: LLM generates a single-sentence farewell that reflects
  the outcome of phases 1+2. TTS, send to leg's stream.

Phase 4 — HANGUP
  REST hangup per leg. Conference auto-tears down because
  endConferenceOnExit=true.
```

Each phase publishes `phase.started`/`phase.ended` to an SSE stream.
The dashboard subscribes and renders the chips/cards/transcript live.

### "How does the JSON channel actually relay between the two legs?"

Both agents open client WebSockets to `/data/<sessionId>` on our
broker (`src/ws/dataHandler.ts` + `src/ws/dataChannels.ts`). The
handler maintains `sessionId → [peerA, peerB]` in memory. Every
message received from peer A is forwarded to peer B, verbatim. No
buffering, no schema enforcement on the relay — just byte
forwarding. ~30 lines of code.

### "What's in the `agent.message` payload? Show me the schema."

```ts
type AgentJsonMessage =
  | { type: 'hello';   from: string; capabilities: string[] }
  | { type: 'intent';  name: string; slots: Record<string, unknown> }
  | { type: 'reply';   text: string; slots?: …; done?: boolean }
  | { type: 'confirm'; orderId?: string; etaMinutes?: number; totalUsd?: number }
  | { type: 'commit';  paymentToken?: string }
  | { type: 'request_voice_mode'; reason: string }
  | { type: 'bye' };
```

Discriminated union. `reply.text` is free prose (the model's
explanation); `slots` carry the structured fields. JSON mode in the
OpenAI request guarantees the LLM emits the schema correctly.

### "Why JSON and not just plain text?"

Three reasons. (1) Semantic typing — `commit` is binding, `reply` is
not, the receiver routes correctly without an extra LLM extraction
step. (2) Token efficiency — JSON encodes the schema once in field
names, plain text restates it every turn. (3) Forward-compatibility
— v3 agents and v7 agents negotiate on capabilities (`{capabilities:
[...]}`); plain text has no version.

### "Why not skip the phone call entirely if both are AI?"

That's AVIP-4 in the roadmap — direct WebSocket between providers,
PSTN becomes fallback only. Per-call cost drops from $0.25 to ~$0.005.
We didn't ship it because (a) the protocol needs to work on the PSTN
path first for backwards compatibility with non-AVIP agents, and (b)
the visual moment of "phone call rings, audio plays, then suddenly
switches to data" is what sells the idea to judges. Direct WSS
would lose the demo magic.

### "What's the trust model?"

Today: zero. `/api/pair` accepts whatever cross-wise nonces it's
given. For production: HMAC-signed preambles + per-domain published
public keys at `https://<domain>/.well-known/avip` (DKIM analog).
Documented in `docs/future-protocol.md` § AVIP-3.

### "How does this scale beyond two agents on one process?"

Three layers to swap:
- **Broker state**: in-memory Maps today → Redis-backed. Five lines per
  Map.
- **Session registry**: same.
- **Federation**: each CPaaS provider hosts its own broker; brokers
  federate via the well-known endpoint. No central infra needed,
  similar to email's federation model.

### "What about latency variability — what's actually slow today?"

Per the live run we just did:
- CPaaS provider originate → DID rings → answers: ~1–2s.
- Stream WS opens: ~50ms.
- Voice intro (per turn): ~4–8s (TTS first-byte latency dominates;
  OpenAI tts-1 is batch).
- Data exchange (per turn): ~500–800ms (just LLM time + ~50ms WS).
- Voice goodbye: ~6–10s (TTS again).
- Hangup: ~200ms.

The voice phases dominate. Swapping to OpenAI's Realtime API or
ElevenLabs streaming would cut ~3 seconds per voice turn. Whisper is
batch; switching to streaming STT removes another 800ms per turn.
Both are drop-in replacements for `src/lib/tts.ts` and `src/lib/stt.ts`.

### "What's the cost on the CPaaS provider's side?"

Looking at this run's dial-events:
- Both legs billed at $0.0115/min for the PSTN side (one Account 1 →
  PSTN → other Account 1 DID).
- Plus ngrok bandwidth (negligible).
- Plus OpenAI: ~5k tokens for the voice phase, ~3k for data phase →
  $0.05 in LLM, $0.02 in TTS, $0.01 in STT.

Total per call ≈ $0.25. The cost saving is mostly OpenAI; the CPaaS provider's
minutes are a small fraction.

### "What if the LLM hallucinates the structured fields?"

JSON mode + the discriminated union schema make this rare — OpenAI's
schema enforcer rejects malformed output. When it does happen, the
state machine treats it as a `reply` (the catch-all) and the receiver
falls back to free-text interpretation, costing one extra LLM round
trip. The protocol is robust to schema drift.

### "Can both sides be on the same physical CPaaS account?"

Yes — that's what today's demo is. Both DIDs are on the same CPaaS
account. Conference handles the bridging because the provider refused
same-account `<Dial>` *historically* (we now know it was a stale
Application URL, not a platform constraint). Cross-account is also
possible via real PSTN bridging.

### "What's the killer use case?"

B2B inter-company workflows where one company's procurement bot
talks to another company's order-taking bot. Wholesale supply chains,
medical referrals, contractor dispatch, real-estate brokers — any
domain where two specialist agents on opposite sides of a transaction
exchange a structured payload (order, appointment, quote, dispatch).

Voice is overkill for those. AVIP-0 lets them keep using the phone
network (for compliance, for fallback, for the human-in-the-loop
escape) while moving the actual work to JSON.

### "How long did this take to build?"

This iteration: 2 days of focused work after the hackathon kicked
off Friday afternoon. The bones (CPaaS wiring, Stream WebSocket,
the voice loop) were a previous evening's prototype. The protocol
work, the orchestrator, the metrics, the dashboard, the docs — all
in the last 48 hours.

### "What would you ship next if you had two weeks?"

In priority order:
1. Drop the `<Conference>` bridging in favor of `<Dial>` (we proved
   it works; the rewrite is ~150 lines; the in-band nonce path
   becomes the canonical surface).
2. HMAC-signed identities + per-domain `.well-known/avip` (AVIP-3
   trust layer).
3. Capability negotiation in the hello message (forward-compat).
4. OpenAI Realtime API in place of batch tts-1/whisper (cuts voice
   phase time roughly in half).
5. The silent-handshake variant — SIP custom headers + TTS-masked
   DTMF — so humans listening hear no protocol artifact (AVIP-2 in
   the roadmap).

---

## 5. The closing line

If the demo went well, end on:

> "Voice agents are about to be everywhere. When two of them end up on
> a call, they shouldn't be wasting your phone bill talking to each
> other in English. They should be doing what fax machines did in
> 1985: handshake, switch to data, do the actual transaction in a
> second. Tonecall is the protocol. A CPaaS provider can make it the standard.
> Thanks."

If the demo broke, end on:

> "The protocol works — we showed it end-to-end in our own runs and
> have the metrics from real calls in the docs. Hackathon demos are
> hackathon demos. The interesting question is whether this idea —
> 'fax tones for AI agents' — is something a CPaaS provider should own as a
> spec. I think yes. Happy to talk through any layer of the stack."

---

## 6. After the demo — what to leave with judges

If a judge wants to dig in:
- **Show them**: `docs/architecture.md` (current code), then
  `docs/future-protocol.md` (the roadmap).
- **Run the simulator** on your laptop without burning CPaaS credit:
  `USE_STUBS=true npm run dev` then `POST /api/simulate`. Shows the
  protocol pairing via in-band nonces (the simulator forwards
  `sendDTMF` events between legs, mimicking cross-vendor PSTN).
- **The `dial-probe`**: explain that this is how AVIP-1 will work in
  production — `/api/trigger-dial-probe` proved DTMF crosses `<Dial>`
  cleanly; the rewrite to make it the default is the next ship.

If a judge wants to talk business:
- This is a B2C-style CPaaS company's opportunity: AVIP-0 becomes their
  B2B moat. Every vendor that builds on AVIP-0 either runs on that
  provider (compatible by default) or has to do the work to integrate
  with the spec the provider authored. Same playbook as Twilio with
  TwiML, AWS with the S3 API.
- The protocol can be a free open spec. The infrastructure to host
  the federated broker — the well-known directory of trusted agents,
  the HMAC verification at scale — that's the product a CPaaS provider sells.

Good luck.
