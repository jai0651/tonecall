# Inter-Agent Voice Handshake — Full Design Doc

A hackathon idea for a CPaaS **for-agents** track: when two AI voice agents end up on a call with each other, they detect each other and switch from slow speech-to-speech to a fast structured data channel — brokered by your CPaaS provider. Audibly reminiscent of fax/modem handshakes.

This doc is written for someone new to voice protocols. It explains the building blocks first, then the idea, then honestly evaluates whether it will work.

---

## 1. The problem in plain English

Today, when two AI voice agents talk to each other on a phone call, they do this on every turn:

```
Agent A thinks "I want to say X"
  → TTS (text-to-speech) converts text into audio       (~500ms)
  → audio travels across phone networks                 (~100-300ms)
  → Agent B's STT (speech-to-text) converts back to text (~800ms)
  → Agent B's LLM reads the text and reasons            (~1500ms)
  → Agent B's TTS converts response to audio            (~500ms)
  → audio travels back                                  (~100-300ms)
  → Agent A's STT converts back to text                 (~800ms)

≈ 4-5 seconds per round-trip, with errors injected at every step
```

For two agents to negotiate a 5-slot transaction ("pizza order: size, toppings, address, time, payment"), that's 25-60 seconds and 10 chances for STT to mis-hear "extra cheese" as "extra Swiss." Both sides pay for tokens, both pay for TTS minutes, both pay for STT minutes.

**The insight**: if both sides are agents, the audio channel is wasted bandwidth. They could just exchange JSON. They only need the audio channel for *humans*.

So: keep the call open, but route the actual data over a side-channel. Use the voice channel as a *fallback* (if a human joins, or if confusion strikes).

---

## 2. Voice-protocol primer (skim if you know this)

You need ~8 concepts to follow the rest:

### 2.1 PSTN
The **Public Switched Telephone Network** — the global phone system. Numbers like `+1-415-...` route through PSTN. It's a circuit-switched legacy network at the edges, but most of it has been internally upgraded to packet networks. From an application's view: you dial a number, audio flows in both directions, that's it.

### 2.2 SIP
**Session Initiation Protocol** — how modern VoIP calls are *set up* (dialed, answered, hung up). Think of it as HTTP-for-phone-calls. It carries call control messages ("INVITE this number", "200 OK accepted", "BYE hung up"). It does **not** carry the actual voice audio.

### 2.3 RTP
**Real-time Transport Protocol** — the protocol that actually carries the voice audio packets once a SIP call is connected. UDP-based, packets every 20ms.

### 2.4 Codecs
The audio is compressed/encoded. Common ones:
- **G.711** (μ-law / a-law): 64 kbps, basically uncompressed, sounds fine, what carriers use by default.
- **Opus**: modern, variable bitrate, used in WebRTC.
- **G.729 / GSM**: heavy compression, common on cellular legs, distorts non-speech audio (bad for modem tones).

When a call traverses multiple networks, the audio gets **transcoded** (decoded and re-encoded) at each hop. This is fine for speech but lossy for anything else.

### 2.5 DTMF
**Dual-Tone Multi-Frequency** — the touch-tones when you press 1-9, `*`, `#`. Each button is a pair of sine waves at specific frequencies. Phone systems were designed around DTMF, so it survives across carriers and codecs. There are two ways DTMF can travel:

- **In-band DTMF**: tones played as actual audio in the RTP stream. Can be mangled by aggressive codecs.
- **RFC 2833 / out-of-band DTMF**: tones sent as special signaling events alongside the audio. Rock-solid through any modern network.

**This matters a lot for our design.** Most CPaaS providers support both; we'll require RFC 2833.

### 2.6 CPaaS
**Communications-Platform-as-a-Service** — companies that own phone numbers, run SIP infrastructure, and expose APIs so developers can `POST /calls` instead of running their own telecom stack. Importantly, when your call goes through a CPaaS provider, **the provider sees both ends** and can inject signals, record, conference, etc.

### 2.7 Voice AI
What CPaaS providers now sell on top of the phone stack: managed STT + LLM + TTS pipelines you can drop into a call. You give it a system prompt; it answers your phone. This is the layer our "agent" lives in.

### 2.8 Webhooks
When something happens on the call (dial, answer, hangup, DTMF pressed), your CPaaS provider can `POST` to your server. This is how your code reacts to call events.

### 2.9 Historical precedent: modems and fax
Old modems sent digital data over voice phone lines by encoding bits as audio tones (FSK — frequency-shift keying). Fax machines do the same. The "screeching" sound at call start is the two devices negotiating speed and modulation. **We are reinventing this idea, but cheating: we'll use the audio channel only for "detection" and let the actual data flow over the internet via your CPaaS provider.**

---

## 3. The idea, in one paragraph

When a voice agent connects to a call, it emits a short DTMF preamble (`*0*` + a nonce). It listens for the same pattern from the other side. If both sides emit it, they each tell the CPaaS provider "I'm an agent, paired on call X, here's my nonce." The provider verifies both nonces match the same call, then opens a WebSocket between the two agents. From then on, the agents exchange structured JSON over the WebSocket at internet speed, while the phone call stays open for humans / fallback. To make the demo memorable, we play stylized modem audio over the phone line during the JSON exchange so audiences hear "the agents are talking."

---

## 4. End-to-end walkthrough

Let's trace a call: Agent A (a customer agent) calls a pizza shop's number, which is also answered by an agent (Agent B).

### Step 0: Setup (before the call)
- Both agents are registered with the CPaaS provider's "agent registry": each has an `agent_id` and an HMAC signing key.
- Both agents run a small SDK that wraps the standard voice agent pipeline with handshake logic.

### Step 1: Call connects
Agent A's backend dials the CPaaS provider's API:
```
POST /v1/calls { from: "+1-A", to: "+1-B", answer_url: "https://a.com/answer" }
```
The provider dials `+1-B`, which routes to Agent B's voice infra. Both sides are now in a normal SIP/RTP call. **At this point, neither agent knows the other side is an agent.**

### Step 2: Preamble exchange (the "hello, are you an agent?" handshake)
Within the first ~500ms of the call, each agent emits a DTMF sequence:
```
*0* <8-digit nonce> #
```
- `*0*` = magic prefix that means "I am an agent, handshake protocol v0."
- nonce = random 8 digits, valid only for this call.
- `#` = end marker.

Each agent is also *listening* for this pattern from the other side via DTMF webhooks from the CPaaS provider.

**Three possible outcomes:**
- Both agents hear the other's preamble → both agents are agents → continue to Step 3.
- Only one side hears it → the other side is human → fall back to normal voice conversation.
- Neither hears it → silent / noise / human → fall back to normal voice.

### Step 3: Pairing with the broker (the trust step)
Both agents independently POST to the CPaaS broker:
```
POST /v1/agent-pair
{
  "agent_id": "agent_A_id",
  "call_uuid": "call-uuid-from-provider",
  "my_nonce": "12345678",
  "peer_nonce": "87654321",
  "hmac": "<signed hmac>"
}
```

The broker:
1. Verifies HMAC against the agent's registered key.
2. Looks up the call_uuid — confirms the agent's leg is actually on this call.
3. Waits for the other side to POST with mirror-image nonces.
4. When both arrive and match → opens a WebSocket session, sends both agents a `session_id`.

This is the trust root. Without the broker, agents could spoof each other; with it, only agents who:
- Are actually on the call (the provider verifies),
- Hold the matching agent key (HMAC),
- Successfully exchanged nonces over the actual audio channel (proof of co-presence),

…can be paired. That's belt-and-braces secure.

### Step 4: WebSocket session
Both agents now have an open WebSocket to the CPaaS broker, which relays messages between them.

```
A → Broker → B :  {"type": "hello", "capabilities": ["pizza_order_v1"]}
B → Broker → A :  {"type": "hello", "capabilities": ["pizza_order_v1"]}
A → Broker → B :  {"type": "intent", "name": "order_pizza", "slots": {
                    "size": "large", "toppings": ["pepperoni", "mushroom"],
                    "address": "...", "time": "ASAP"}}
B → Broker → A :  {"type": "confirm", "order_id": "X742", "eta_minutes": 22,
                    "total_usd": 18.50}
A → Broker → B :  {"type": "commit", "payment_token": "tok_..."}
B → Broker → A :  {"type": "done"}
```

Total: ~5 round trips, ~200ms each = ~1 second. Compare to ~45 seconds for the spoken version.

### Step 5: Voice channel during data exchange
The phone call is still up. What do you do with the audio?

**Three options:**
- **Silence it** — boring; humans listening think the call dropped.
- **Hold music** — confusing; sounds like a normal hold.
- **Stylized modem audio** *(recommended)* — play a soft FSK-sounding pattern so anyone listening hears "data is being exchanged." This is purely cosmetic; the real data flows over WebSocket. It's also the demo moment that makes the audience clap.

### Step 6: Voice fallback / human interrupt
Either agent can signal `{"type": "request_voice_mode", "reason": "..."}` and both fall back to TTS/STT. Triggers:
- LLM confidence on an intent drops below threshold.
- A human picks up an extension and starts speaking (the provider can detect speech energy).
- A conversation step has no structured schema yet.

This keeps the design **safe**: the voice channel is the always-available fallback. Worst case, we degrade to current behavior, which is the floor today.

### Step 7: Hangup
Either side sends `{"type": "bye"}` over WebSocket, both close their legs via the provider's hangup API. Done.

---

## 5. ASCII architecture diagram

```
                       ┌──────────────────────────┐
                       │   CPAAS AGENT BROKER     │
                       │                          │
                       │  - validates HMAC        │
                       │  - matches nonces        │
                       │  - opens WS sessions     │
                       │  - relays JSON           │
                       └──────┬──────────────┬────┘
                              │              │
                       (WS)   │              │   (WS)
                              │              │
                ┌─────────────▼────┐   ┌─────▼─────────┐
                │   AGENT A        │   │   AGENT B     │
                │  (pizza customer)│   │ (pizza shop)  │
                │                  │   │               │
                │  - LLM           │   │  - LLM        │
                │  - CPaaS SDK     │   │  - CPaaS SDK  │
                │  - TTS/STT       │   │  - TTS/STT    │
                │   (fallback)     │   │   (fallback)  │
                └─────────┬────────┘   └────┬──────────┘
                          │                  │
                          │  SIP signaling   │
                          │  RTP audio       │
                          │                  │
                ┌─────────▼──────────────────▼────────┐
                │            CPAAS PSTN/SIP          │
                │     (the normal phone call leg)    │
                └────────────────────────────────────┘

Timeline:
  t=0.0s   call connects, RTP flows
  t=0.3s   both agents emit DTMF preamble *0*NONCE#
  t=0.7s   both agents detect peer preamble (via CPaaS DTMF webhook)
  t=0.8s   both POST /agent-pair to broker
  t=1.0s   broker opens WS, sends session_id to both
  t=1.0s+  agents exchange JSON over WS while audio plays modem tones
  t=~2.5s  transaction done, hangup
```

---

## 6. Concrete implementation with CPaaS audio streaming

This section is the "wire by wire" view. Every box you'll deploy, every WebSocket, every event — for someone new to voice protocols.

### 6.1 What the CPaaS `<Stream>` verb actually gives you

The `<Stream>` verb (a pattern common across CPaaS providers, e.g. Twilio Media Streams) taps a live call's audio into a WebSocket you control:

```xml
<Response>
  <Stream bidirectional="true" streamTimeout="3600" keepCallAlive="true">
    wss://your-middleware.com/voice-stream/{call_uuid}
  </Stream>
</Response>
```

Over that WebSocket:
- **Inbound (provider → you):** JSON frames with base64 μ-law 8kHz audio, ~20ms per chunk — what's being said on the call.
- **Outbound (you → provider):** JSON frames with base64 audio that the provider injects into the call as if you were speaking.
- **Events:** `start`, `media`, `dtmf`, `stop`. DTMF arrives as discrete events here.

This single WebSocket is your **voice plane** — full read/write of the call audio.

### 6.2 The 7 boxes (everything you deploy)

```
1. CPAAS CLOUD             — owns +1-A and +1-B, runs the actual phone call
2. YOUR ANSWER URL         — HTTP endpoint, replies with <Stream> XML
3. YOUR VOICE WS HANDLER   — receives audio from the provider, sends audio back
4. YOUR LLM AGENT          — reads prompt + context, produces replies
5. YOUR STT / TTS          — Deepgram + ElevenLabs (only used in VOICE mode)
6. YOUR BROKER             — pairs two middlewares, opens the data WebSocket
7. YOUR DATA WS HANDLER    — sends/receives JSON between paired agents
```

Boxes 2–7 all live on **your infra** — one FastAPI app is fine for the hackathon. Only box 1 is the CPaaS provider.

### 6.3 Setup before any call

```
┌─────────────────────────────────────────────────────────────────┐
│ YOUR INFRA (single service, e.g. middleware.example.com)        │
│                                                                 │
│   POST /answer/{number}     → returns <Stream> XML              │
│   WS   /voice/{call_uuid}   → bidirectional audio with provider │
│   POST /pair                 → broker pair endpoint              │
│   WS   /data/{session_id}    → JSON relay between two agents    │
│                                                                 │
│   AGENT_CONFIGS = {                                             │
│     "+1-A": {prompt: "you are a vegetable vendor...", ...},    │
│     "+1-B": {prompt: "you are a pizza shop...", ...},          │
│   }                                                             │
└─────────────────────────────────────────────────────────────────┘

In the provider's console:
  +1-A → answer_url = https://middleware.example.com/answer/+1-A
  +1-B → answer_url = https://middleware.example.com/answer/+1-B
```

Two numbers, one service, one config dict. That's it.

### 6.4 Scenario A: Agent calls Agent (the main case)

Vegetable-vendor agent dials the pizza shop. Step by step:

**t = 0.0s — trigger.** You hit a "demo" button. Your backend calls:
```python
cpaas_client.calls.create(
    from_="+1-A",
    to_="+1-B",
    answer_url="https://middleware.example.com/answer/outbound/+1-A",
)
```

**t = 0.1s — the CPaaS provider sets up TWO call legs.** PSTN has no concept of "agent-to-agent." It bridges:
- **Leg A** (outbound from +1-A): the provider POSTs your outbound answer URL.
- **Leg B** (inbound to +1-B): the provider POSTs your inbound answer URL.

Each leg has its **own** `call_uuid`. They're related (same bridged call) but separate from your code's point of view.

**t = 0.2s — both legs answered with `<Stream>`.** Both answer URLs return the `<Stream>` XML. The provider opens **two** voice WebSockets to your service:
- `wss://.../voice/CALL_UUID_A` ← audio of leg A
- `wss://.../voice/CALL_UUID_B` ← audio of leg B

Your middleware sees both sides.

**t = 0.3s — spawn one handler per leg.** Each handler knows which agent it represents (number → config lookup):

```python
@app.websocket("/voice/{call_uuid}")
async def voice_ws(ws, call_uuid):
    number = lookup_number_for_call(call_uuid)   # +1-A or +1-B
    config = AGENT_CONFIGS[number]
    nonce  = random_8_digits()

    cpaas_client.calls.send_digits(call_uuid, digits=f"*0*{nonce}#")

    peer_nonce = await listen_for_peer_preamble(ws, timeout=1.5)
    if peer_nonce:
        await paired_mode(ws, call_uuid, config, nonce, peer_nonce)
    else:
        await voice_mode(ws, config)
```

**t = 0.4s — DTMF preambles cross.** Handler A injects `*0*11111111#` into leg A → audible on leg B (the provider delivers it as `dtmf` events on leg B's voice WebSocket). Same in reverse.

```
Handler A's view:                Handler B's view:
  ws received: dtmf "*"            ws received: dtmf "*"
  ws received: dtmf "0"            ws received: dtmf "0"
  ws received: dtmf "*"            ws received: dtmf "*"
  ws received: dtmf "2"            ws received: dtmf "1"
  ws received: dtmf "2" ...        ws received: dtmf "1" ...
  → peer_nonce = "22222222"        → peer_nonce = "11111111"
```

**t = 0.6s — both POST to broker.**
```python
POST /pair
{"agent_number": "+1-A", "call_uuid": "CALL_UUID_A",
 "my_nonce": "11111111", "peer_nonce": "22222222"}
```

The broker doesn't match `call_uuid`s (different per leg). It matches **nonces cross-wise**: A reports (mine=N1, peer=N2); B reports (mine=N2, peer=N1). When both arrive, same call confirmed → open data WS.

**t = 0.7s — data WebSocket opens.** Broker returns a `session_id`. Both handlers connect to `wss://broker/data/{session_id}`. Broker relays every message between them.

**t = 0.8s onwards — the actual conversation.** Per handler, two concurrent coroutines:

```python
async def paired_mode(voice_ws, call_uuid, config, my_nonce, peer_nonce):
    data_ws = await pair_with_broker(call_uuid, my_nonce, peer_nonce)
    await asyncio.gather(
        run_agent_over_json(data_ws, config),   # the real conversation
        pump_modem_audio(voice_ws),              # cosmetic chirps for humans
    )

async def run_agent_over_json(data_ws, config):
    await data_ws.send(json.dumps({"type": "hello", "from": config["name"]}))
    async for raw in data_ws:
        peer_msg = json.loads(raw)
        reply = await llm.respond(system=config["prompt"], input=peer_msg)
        if reply.get("done"):
            await data_ws.send(json.dumps({"type": "bye"}))
            return
        await data_ws.send(json.dumps(reply))
```

What flows over each socket:
```
voice_ws (per leg):              data_ws (shared via broker):
  out: modem chirp audio           out: {"intent":"order_pizza", ...}
  in:  audio frames (ignored)      in:  {"reply":"confirmed", ...}
```

**STT and TTS are not in the loop.** LLM runs against JSON. Per-turn latency ≈ LLM time + ~50ms WS round-trip. No 800ms STT, no 500ms TTS.

**t = ~3s — done.** Either side sends `{"type":"bye"}`. Both handlers tear down their legs via `cpaas_client.calls.delete(call_uuid)`.

### 6.5 Scenario B: Human calls Agent (fallback)

Real human dials +1-A from a cell phone.

**t = 0.0–0.2s.** Same as before, but only **one** voice WebSocket opens (the human's phone has no `<Stream>`).

**t = 0.3–1.8s — handshake fails.** Handler emits `*0*<nonce>#`. The human hears ~1s of beeps. No peer DTMF returns. After 1.5s timeout, transition to `voice_mode`.

**t = 1.8s onwards — be a normal voice agent.**

```python
async def voice_mode(voice_ws, config):
    stt = DeepgramStream()
    greeting = await tts.say(f"Hi, this is {config['name']}, how can I help?")
    await send_audio(voice_ws, greeting)

    async for raw in voice_ws:
        msg = json.loads(raw)
        if msg["event"] == "media":
            audio_chunk = base64.b64decode(msg["payload"])
            transcript = await stt.feed(audio_chunk)
            if transcript:
                reply_text  = await llm.respond(config["prompt"], transcript)
                reply_audio = await tts.say(reply_text)
                await send_audio(voice_ws, reply_audio)
```

This is just a normal voice AI built on the CPaaS provider's streaming API. The handshake never engaged; the same vegetable-vendor prompt drives an STT→LLM→TTS loop. The 1.5s of preamble beeps at start can be suppressed for inbound-from-non-agent calls in production. For hackathon, live with them.

### 6.6 Combined picture

```
                  ╔═══════════════════════════════╗
                  ║         CPAAS CLOUD           ║
                  ║   +1-A           +1-B         ║
                  ║    │              │            ║
                  ║    │ Stream WS    │ Stream WS  ║
                  ╚════│══════════════│════════════╝
                       │              │
              ┌────────▼──────────────▼───────┐
              │   YOUR MIDDLEWARE             │
              │                               │
              │   /answer/...    /voice/...   │
              │   /pair          /data/...    │
              │                               │
              │   Handler A     Handler B     │
              │      │              │         │
              │      │   data_ws    │         │
              │      └───┬──────────┘         │
              │          │                    │
              │       BROKER                  │
              │                               │
              │   LLM (OpenAI gpt-4o-mini)    │
              │   STT (OpenAI Whisper) ──┐    │
              │   TTS (OpenAI tts-1)     ┴    │
              │              only in VOICE    │
              └───────────────────────────────┘

Agent-to-Agent:    2 voice WSes, 1 data WS, LLM with JSON I/O, no STT/TTS
Human-to-Agent:    1 voice WS,   0 data WS, LLM with text I/O, STT+TTS live
```

### 6.7 Three things to make explicit

1. **How does it physically work?** The CPaaS provider's `<Stream>` verb is the wire. Bidirectional WebSocket carrying audio + DTMF events. You receive audio, you send audio. That's the entire mechanism.
2. **Where does the agent live?** In your middleware. The prompt is a config-dict entry keyed by phone number. The LLM is a library call (OpenAI API). The provider doesn't run your agent — it just delivers the call audio to you.
3. **What does the data WebSocket do?** A **separate** WebSocket, nothing to do with the CPaaS provider. Your broker (also your infra) accepts connections from paired middlewares and relays JSON. The voice WebSocket continues in parallel for fallback or cosmetic modem audio.

Two WebSockets per leg in agent-to-agent mode. One WebSocket per call in human-to-agent mode. Same prompt drives both, just different I/O shapes (JSON vs text-from-STT).

### 6.8 Runnable skeleton

A FastAPI starting point lives next to this doc: [`inter-agent-handshake-skeleton.py`](./inter-agent-handshake-skeleton.py). It implements the full state machine with CPaaS + LLM + STT + TTS calls stubbed out. Drop in your CPaaS creds and an API key for the LLM and it boots.

---

## 7. What you actually need to build (MVP)

Five components, in increasing order of effort:

### 7.1 CPaaS number provisioning + answer URL
Standard CPaaS setup. Two numbers, two answer URLs. ~30 min.

### 7.2 Agent SDK (Python)
Thin wrapper around your existing voice agent stack. Three public functions:
```python
async def emit_preamble(call_uuid: str) -> str:  # returns own nonce
async def detect_peer(call_uuid: str, timeout=2.0) -> Optional[str]:  # returns peer nonce or None
async def open_sidechannel(call_uuid, my_nonce, peer_nonce) -> WebSocket
```
~200 lines. ~4 hours.

### 7.3 CPaaS broker (FastAPI server)
- `POST /agent-pair` — validates and pairs.
- WebSocket `/agent-ws/{session_id}` — relays messages.
- In-memory pairing state (no DB needed for hackathon).
~150 lines. ~3 hours.

### 7.4 Two demo agents
- "Pizza customer" agent: dials the shop, orders.
- "Pizza shop" agent: takes the order.
Both use the SDK. Both define a tiny `pizza_order_v1` intent schema.
~300 lines total. ~5 hours.

### 7.5 Demo UI
Split screen:
- Left: live transcript of "baseline" call (TTS/STT, slow).
- Right: live JSON exchange of handshake call (fast).
- Bottom: audio waveform of both calls so audience can hear the modem moment.
~200 lines of plain HTML+JS over the broker's WebSocket. ~3 hours.

**Total: ~15 focused hours of work, very achievable in a 48-hour hackathon with 2 people.**

---

## 8. Will this actually work? Honest verdict

**Yes, the mechanics work.** Every primitive in the design is a proven, decades-old building block:

| Component | Proven? | Notes |
|---|---|---|
| Dial + connect two numbers via a CPaaS provider | ✅ Production-stable | A CPaaS provider's day job. |
| Send DTMF in-call | ✅ Production-stable | The provider's DTMF-play API. |
| Receive DTMF webhook | ✅ Production-stable | The provider's `DTMF` callback. |
| HMAC nonce auth | ✅ Cryptographically sound | Standard primitive. |
| Open WebSocket from agent to broker | ✅ Trivial | FastAPI and most CPaaS voice APIs both support it. |
| JSON over WebSocket relay | ✅ Trivial | A 30-line Python relay works. |
| Play stylized audio in-call | ✅ Production-stable | The provider's `Play` verb. |

**There is no novel physics here.** The innovation is purely in the *composition* and the *positioning* — using a CPaaS as the trust broker for agent-to-agent voice negotiation. That's a product idea, not a research bet.

### What's genuinely uncertain

1. **DTMF timing edge cases.** What if both preambles overlap and corrupt each other's detection? Mitigation: a tiny random jitter (50-200ms) before emitting, plus a retry. Worst case ~1s added.
2. **DTMF reliability on weird carrier paths.** If one leg is a satellite phone in Antarctica, the DTMF might not survive. Mitigation: insist on RFC 2833 (out-of-band DTMF), which most CPaaS providers support. For PSTN legs that don't, fall back to spoken codeword detection ("AGENTPROTOZERO"). This degrades gracefully.
3. **Latency wins assume the LLM is fast.** If your agent's LLM is a 30s reasoning model, saving 40s of TTS/STT doesn't matter. The win is real for fast, structured intents (order-taking, scheduling, lookups), not for long deliberative conversations.
4. **Adoption** — only useful when *both* sides use the protocol. For a hackathon demo this is fine (we control both). For a real product, this is the "fax machine bootstrap" problem: it's most valuable when many systems support it. A CPaaS provider is uniquely positioned to seed it (they could enable it by default for any voice agent built on their platform).

### What WON'T work, to set expectations

- **Trying to push real JSON over DTMF or in-band audio modulation.** DTMF caps at ~40 bps; in-band FSK gets shredded by codec transcoding. We do NOT do this. Audio is for detection + cosmetic flair only. The WebSocket carries the data.
- **Skipping the trust broker.** Without a CPaaS provider (or an equivalent broker) verifying both legs and matching nonces, the protocol is spoof-able. Don't.
- **Cross-platform out of the box.** If the other side is on a different CPaaS provider's agent platform, they'd need to implement the spec too. Make the spec open ("Agent Voice Interop Protocol v0") so this is a path forward, not a roadblock.

### Bottom line

This is a real, buildable system. The novel part isn't the technology — it's the framing ("fax tones for AI agents") and the realization that a CPaaS is the natural broker. Every individual piece is boring. The composition is interesting.

For a hackathon: build the MVP, do the side-by-side demo, write the protocol spec as a one-page PDF, and call it "AVIP-0 — the Agent Voice Interop Protocol, draft 0." That gives it a future beyond the hackathon.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DTMF preambles collide / aren't detected | Medium | Low | Jitter + retry; fall back to voice |
| Broker downtime | Low | High | Fall back to voice; broker stateless = easy to scale |
| Codec transcoding mangles preamble | Low | Medium | Require RFC 2833; fall back to spoken codeword |
| One side has fast TTS/STT — gains are smaller | Medium | Low | Still meaningful; the consistency and error reduction matter |
| Spoofing / replay attack | Low (with HMAC) | High | HMAC + per-call nonces + short TTL |
| Human silently listening misses critical info | Low | Medium | Play stylized audio so humans know "data is flowing" |
| Hackathon judges don't get it | Medium | High | The side-by-side demo + modem audio sells itself |

---

## 10. Glossary (quick reference)

- **PSTN** — the global phone system.
- **SIP** — call setup protocol (dial/answer/hangup).
- **RTP** — actual audio packets in flight.
- **DTMF** — touch-tones; survive any phone network.
- **RFC 2833** — out-of-band DTMF (more reliable than in-band).
- **Codec** — audio compression scheme (G.711, Opus, GSM).
- **Transcoding** — re-encoding audio at a network boundary.
- **CPaaS** — Communications-Platform-as-a-Service; sells phone numbers + SIP + APIs.
- **FSK** — frequency-shift keying; how old modems sent data over audio.
- **TTS / STT** — text-to-speech / speech-to-text.
- **Webhook** — HTTP callback on call events.
- **Nonce** — random number used once, for security.
- **HMAC** — hash-based message auth code; proves you hold a secret key.

---

## 11. What to call it

- **AVIP** — Agent Voice Interop Protocol
- **Tonecall** — agents that talk in tones, not words
- **CPaaS Handshake** — boring but clear
- **WhistleSync** — the most fun name

Pick whatever survives the team's chat.
