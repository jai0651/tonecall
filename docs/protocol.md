# The Protocol — explained for the stage

> ⚠️ **Partially superseded.** Surface A (shared coordination key) has been
> removed from the code: every real call now pairs via Surface B (in-band
> DTMF nonce over a `<Dial>` bridge), which is what AVIP-1 promised. See
> [`avip-1-dial.md`](./avip-1-dial.md).

> Companion to `docs/architecture.md`. Read this if you need to **answer
> questions** about the protocol on stage. The architecture doc tells you
> how the *code* works; this doc tells you how to *talk about* what the
> code is doing.

---

## What "the protocol" is, in one sentence

**AVIP-0 (Agent Voice Interop Protocol v0) is the handshake that lets two AI voice
agents who end up on the same phone call recognise each other and switch
from spoken English to a structured JSON side-channel, while keeping the
voice line open as a fallback.**

That's the entire pitch. Everything below is the moving parts.

---

## The protocol has exactly 4 parts

Memorise these — every "deep" judge question maps to one of them.

### 1. Discovery — *"are you also an agent?"*

How each agent signals "I'm an AI agent built on AVIP-0." Two surfaces,
both write into the same broker:

| Surface | Signal | Where it works |
|---|---|---|
| **A — Shared coordination key** | Both legs land on the same middleware, both share a key derived from `(from, to)` | Today's demo on Plivo single-account |
| **B — In-band DTMF nonce** | Each agent plays `9090<8-digit-nonce>#` as DTMF via Plivo's `sendDTMF` event; peer hears it as `dtmf` events on its stream | Cross-vendor PSTN bridge; verified by the dial probe; ships in v1 |

Both surfaces produce the same outcome (a shared `sessionId`) — the
agents downstream don't know or care which surface fired.

### 2. Pairing — *"I'll talk to you, not someone else on the line"*

The broker matches two pieces of evidence cross-wise:

```
Agent A POSTs /api/pair { myNonce: N1, peerNonce: N2 }
Agent B POSTs /api/pair { myNonce: N2, peerNonce: N1 }
                ↓
       broker matches (N1↔N2)
                ↓
       returns sessionId to both
```

(In the single-vendor demo, replace nonces with the shared conference
name. Same matching logic, different evidence.)

### 3. Data channel — *"let's talk JSON now"*

Both agents open WebSocket connections to `/data/<sessionId>` on the
broker. The broker is dumb — it just byte-forwards every message from
peer A to peer B. ~30 lines of code.

### 4. Schema — *the language they speak*

Discriminated union of message types:

```ts
hello   { from, capabilities: [...] }
intent  { name, slots: {...} }
reply   { text, slots?, done? }
confirm { orderId, etaMinutes, totalUsd }
commit  { paymentToken }
bye
```

The receiver can `switch (msg.type)` and route correctly without ever
calling an LLM to "interpret" the message. That's the cost saving.

---

## AI vs human detection — how it actually works

This is the question judges will absolutely ask. Precise answer:

### The detection rule (today's code)

**Run a 15-second listening window. If concrete evidence of an AI peer
arrives, pair via the broker. If 15 seconds pass with no evidence,
assume the peer is human and switch to standard voice (STT → LLM → TTS)
mode.**

### What "concrete evidence" means

- **Surface A (single-vendor):** there's an entry in our
  `conferenceRegistry` saying "this callUuid belongs to a coordinated
  agent session." That entry was put there by `/api/trigger-call` when
  the demo was initiated — a human dialing in from a real phone would
  have no such entry.
- **Surface B (cross-vendor, in-band):** the leg receives DTMF events
  matching the regex `9090(\d{8})#` within the 15-second window.

A human can't accidentally generate Surface B's pattern:

- They'd have to key `9090` then 8 specific digits then `#` within the
  first few seconds of the call.
- Random keypresses don't hit a valid 8-digit nonce — collision
  probability is **10⁻⁸**.
- Most humans don't touch the keypad at all in the first 15 seconds.

### Why "no evidence in 15 seconds" is reliable

- An AI agent that speaks AVIP-0 will signal its presence within ~1
  second of the stream opening. The preamble takes ~3 seconds to play;
  pairing completes in ~5 seconds total. **15 seconds is 3× the worst
  case.**
- A human just isn't going to look like an AI agent in this window.
  Not even close.

### What happens when detection identifies a human

The state machine drops to `runVoiceMode`:

- Greets the human with a hardcoded line (*"Hi, this is Anil from
  Mumbai Fresh Produce…"*).
- Loops: caller speaks → Whisper STT → GPT-5.2 reply → tts-1 → back to
  caller.
- Standard voice agent behaviour, indistinguishable from any other
  phone-based AI today.

**The killer property: we never trade off worse human service for
better agent service.** Worst case the protocol is invisible and the
human gets the same experience they'd get without AVIP-0. Best case the
agents save 80% of the cost and time.

---

## How detection evolves

Same fundamental question — *"is this peer an AI?"* — answered four
different ways as the protocol matures.

### v0 — today (shipping in demo)

- **Detection:** shared coordination key in middleware state.
- **What a human hears:** the agents say things like *"sounds like
  we're both AIs, let's switch to data"* out loud — protocol is
  audible.
- **Limitation:** only works when both agents are on our middleware.

### v1 — in-band DTMF over real PSTN (probed today ✓)

- **Detection:** each agent plays `9090<nonce>#` as DTMF. Peer hears it
  on its stream's `dtmf` events. Works on `<Dial>` bridges, including
  cross-vendor PSTN (Plivo ↔ Twilio, Plivo ↔ Telnyx, etc.).
- **What a human hears:** ~3 seconds of beeps at call start (could be
  mistaken for "the system is connecting"), then normal voice agent or
  pleasantries.
- **Verified:** the `/api/trigger-dial-probe` test sent `90901234#`
  via Plivo's `sendDTMF` event on one leg and observed **all 9 digits**
  arriving on the peer leg's stream. Cross-leg DTMF crosses a Dial
  bridge intact.

### v2 — silent handshake (the headline UX upgrade)

- **Detection:** during SIP call setup (before any audio plays), both
  agents inject custom SIP headers:
  ```
  X-AVIP-Agent-Id: pizza-shop@bellapizza.example.com
  X-AVIP-Nonce: 1a8b5e9c…
  X-AVIP-Pubkey-Fp: a3:5f:c2:…
  ```
  Both middlewares see each other's headers in the answer URL webhook
  form data. **They pair before either side speaks a word.**
- **What a human hears:** *nothing*. The handshake happens during call
  setup, in the SIP signaling layer that humans can't hear. The agents
  then have a perfectly natural conversation knowing they're paired.
- **Fallback layer:** if any hop strips SIP custom headers (legacy
  carriers), the system degrades to v1 (audible DTMF). If DTMF gets
  stripped too, degrades to v0 (broker coordination). **Lowest common
  denominator always works.**

### v3 — federated trust

- **Detection:** same as v2 mechanically, but now every nonce is
  HMAC-signed with the agent's per-domain private key. Each agent's
  identity is published at `https://provider.com/.well-known/avip`
  (DKIM-style). Peer fetches the public key, verifies the signature,
  refuses to pair if it doesn't check out.
- **What this prevents:** spoofing. Without v3, a malicious caller
  could fake an AVIP-0 preamble to steal sessions. With v3, spoofing
  requires compromising the agent's actual domain — same security
  model as TLS.

### v4 — skip PSTN entirely

- **Detection:** before dialing, the originating middleware looks up
  the destination agent's `/.well-known/avip` endpoint. If found with a
  `direct_wss` field, it **opens a WebSocket directly instead of
  placing a phone call**.
- **What a human hears:** humans aren't the destination in v4 (the
  lookup tells the system there's an agent there). Humans dialing in
  always trigger v0/v1/v2 PSTN paths.
- **The economics:** PSTN minutes drop from being the default to
  being the human-fallback layer. Cost per agent-to-agent call drops
  from ~$0.25 to ~$0.005. **50× cheaper.**

---

## What to say when a judge asks *"how does it know it's an AI?"*

Three escalating depths. Pick the one that matches the question.

### Surface answer (~10 seconds)

> "We give the agent a 15-second window to announce itself with a known
> signal. A human can't accidentally produce that signal — the
> probability is one in a hundred million. If no signal arrives, we
> assume it's a human and run the normal STT-LLM-TTS voice loop."

### Mid-depth answer (~30 seconds)

> "Two surfaces. Same-vendor case: both legs land on our broker and
> share a coordination key derived deterministically from the two
> phone numbers. Cross-vendor case: each agent plays an 8-digit nonce
> as DTMF — `9090` followed by the nonce followed by `#`. Their peer's
> WebSocket stream surfaces it as `dtmf` events. Both middlewares POST
> to the broker with cross-wise nonces; the broker pairs them. If no
> signal arrives in 15 seconds, the protocol assumes a human caller
> and falls through to the standard voice loop. We never trade off
> human service for agent service."

### Deep answer (~90 seconds, for an infrastructure engineer)

> "Detection lives in `runStateMachine` — `src/ws/stateMachine.ts`. It
> tries pairing surface A first (shared middleware state, today's
> demo), surface B second (in-band DTMF nonce, cross-vendor portable,
> verified by today's probe), and falls through to `runVoiceMode` on
> timeout. The 15-second window is long enough for the slowest
> expected handshake — DTMF preamble takes ~3 seconds to play, Plivo's
> RFC 2833 events surface in ~50ms, broker matching adds ~500ms — so
> 15 seconds is 3× the worst-case AI path. False positives on humans
> are bounded by the regex strictness (`9090\d{8}#`) and the collision
> probability of an 8-digit random number. False negatives on agents
> only happen if the AI side is broken — at which point its peer
> treats it as a human, which is the correct fallback. The protocol
> can degrade infinitely down — broker → DTMF → voice → silence — but
> it can never break hard. Worst case is 'tonight's call costs $0.05
> more than it could have'."

---

## The TL;DR for your stage card

If you remember nothing else:

- **The protocol** is the handshake + pairing + data-channel + schema
  that two AI voice agents use to recognise each other and exchange
  JSON instead of audio.
- **The signal** is a deterministic key (same-vendor) or an in-band
  DTMF nonce (cross-vendor).
- **Detecting humans** is the absence of that signal within 15 seconds
  — at which point the system runs a normal voice agent. Humans don't
  lose anything; agents save 80%.
- **The evolution** is increasingly silent: today the agents announce
  out loud, v1 uses beeps, v2 uses SIP headers no human can hear, v4
  skips the phone call entirely.

That's the protocol. Go demo.
