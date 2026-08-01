# How AVIP-0 evolves — the protocol roadmap

> Read `docs/architecture.md` first. This doc assumes you understand
> what the code does today.

This is the plan for turning Tonecall from a hackathon demo into a real
inter-agent voice protocol. Each version (v0 → v1 → v2 → v3 → v4) is a
discrete deliverable that ships value on its own.

---

## What we have today vs what we want

**Today (AVIP-0):**

- Works on Plivo same-account only (uses Conference + middleware
  coordination as the pairing signal).
- Discovery happens *during* the call by the agents speaking out loud:
  *"Hi, this is X."* / *"Sounds like we're both AIs — switching to data."*
- A human listening hears every word of the handshake. They know what's
  happening.
- No identity verification — anyone who hits `/api/pair` with matching
  nonces gets paired.
- Each `<Stream>` is bidirectional with `audioTrack="inbound"` — a Plivo
  constraint that blocks in-band audio signaling across a Conference
  mixer (see architecture doc §5).

**What we actually want:**

1. **A human listening can't tell the protocol exists.** The discovery
   happens before TTS starts, or so quietly that it never sounds like
   anything a human would think to mention.
2. **Any AI agent on any vendor recognises any other AI agent.**
   Cross-vendor, cross-account, by-spec. Not "we both happen to be
   running on Plivo with the same broker URL."
3. **No waste.** When the handshake succeeds, the slow voice channel
   ramps down to silence (or never goes up). Audio comes back only if
   it needs to.
4. **Trust.** A paired agent has a verifiable identity; a malicious
   third party can't impersonate or eavesdrop.

We get there in four hops.

---

## AVIP-0 — what's shipping (today)

**Goal:** prove two agents on the same vendor can pair and exchange
JSON.

**Signal:** out-of-band — a deterministic conference name derived from
`(numberA, numberB)`. Both legs land on the same broker, the broker
matches them on the shared name, returns one session id.

**Trust:** none. Open pairing endpoint.

**What humans hear:**

```
Phase 1 (voice):   "Hi, this is the pizza shop procurement agent…"
                   "Hi pizza shop, this is the produce vendor."
                   "Sounds like we're both AIs — let's switch to data."
                   "Agreed, switching."
Phase 2 (data):    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  (modem chirp cosmetic audio)
Phase 3 (voice):   "Order confirmed for 6 AM delivery, thanks."
                   "Confirmed, payment received. Goodbye."
```

**Latency saved on a real run:** ~60 seconds.
**Cost saved:** ~52%.

**Why it's just a starting point:** the handshake is audible English.
The pairing only works because both legs land on our middleware.

---

## AVIP-1 — Cross-vendor compatible (next milestone)

**Goal:** make the in-band DTMF nonce path actually work on real PSTN
bridges, so an agent on Plivo can pair with an agent on Twilio /
Telnyx / Vonage without those vendors knowing about each other.

The code already exists (`src/lib/dtmf.ts` + `runInBandNonceHandshake`
in `src/ws/stateMachine.ts`); it just isn't exercised by real calls
because Plivo same-account routes through `<Conference>` and the
conference mixer eats the DTMF (architecture doc §5). On a direct
PSTN bridge between two unrelated CPaaS endpoints, there's no mixer —
DTMF sent on one end's outbound arrives on the other end's inbound
intact.

**Signal:** in-band DTMF preamble.

```
Each agent, on call connect, plays:   9090 <8-digit-nonce> #

  9090  = AVIP-version-1 protocol prefix (purely digits to maximise
          detector reliability — punctuation digits like * sometimes
          get dropped by aggressive RFC 2833 implementations).
  nonce = identifies this leg uniquely.
  #     = end marker.
```

Each agent listens for the peer's preamble via the `dtmf` events on its
own `<Stream>`. When seen, both sides POST to a shared
`/.well-known/avip-broker` endpoint (or a centralised broker) with
`{my_nonce, peer_nonce}`. The broker matches cross-wise. Sessions get
opened on each side's WebSocket.

**Trust:** still none. (Comes in v3.)

**What humans hear:**

```
Phase 0 (~3s):     beep-beep-beep-beep…  (the DTMF preamble — 13 tones)
Phase 1:           same voice intro as v0
Phase 2:           same data exchange
Phase 3:           same voice goodbye
```

So humans still hear the same protocol-aware voice handshake, PLUS
~3 seconds of audible touch-tones at the start. The tones are short
enough to mistake for "the system is connecting" — IVRs play these
all the time. But it's not invisible.

**What this unlocks:**

- A Plivo agent talks to a Twilio agent and they pair.
- A real human keypad on the call would also be seen as DTMF, but
  random key presses won't hit `9090<8-digit>#`, so no false-positive
  pairing.
- A federated broker network is now possible (any AVIP-1 implementer
  can host their own broker; they just need to agree on the digit
  grammar and the broker pairing schema).

**Implementation:** mostly remove the "skip in-band handshake if
conference key is present" branch in `stateMachine.ts`, and arrange
for at least one vendor pair to be on direct-bridged PSTN (not a
conference). Real testing requires actually getting a call set up
across two CPaaS providers — not a code change, a deployment task.

---

## AVIP-2 — Humans don't hear the handshake (the headline upgrade)

**Goal:** zero audible artifact of the protocol. A human on the line
hears two pleasant voice agents having a normal conversation. The
agents have *already* paired silently before either of them speaks.

Three independent mechanisms can each give us this; we'd ship them
together as defence-in-depth.

### 2.1 SIP custom headers — the cleanest path

`<Stream>` and the dtmf events are *audio-plane* things. But SIP — the
signaling protocol that sets the call up — has space for arbitrary
custom headers. Both Plivo and Twilio expose these (`extraHeaders` on
Plivo's Dial / Stream; `X-Twilio-*` on Twilio).

**The idea:** the moment our agent answers the call, before any TTS
plays, we attach a SIP header to our leg:

```
X-AVIP-Agent-Id: pizza-shop@bellapizza.example.com
X-AVIP-Agent-Caps: produce_order_v2,bill_settle_v1
X-AVIP-Pubkey-Fp: a3:5f:c2:…
X-AVIP-Nonce: 1a8b5e9c…
```

PSTN doesn't carry these headers across SIP trunks reliably, but
**SIP-to-SIP** calls (direct CPaaS-to-CPaaS, or any modern VoIP path)
do. When the peer's CPaaS receives the INVITE, it forwards these
headers in the answer webhook to the peer's middleware. The peer reads
them, recognises an AVIP-2 agent on the other end, replies with its own
headers, both sides POST to a broker, session opens.

**What humans hear:** nothing. The discovery happens during call setup
(0–200ms), before either agent answers. The pleasantries that follow
are real pleasantries because both agents already know they're paired
and they're just being polite for any human listening.

**Failure mode:** if any hop in the SIP path strips custom headers
(common on legacy PSTN gateways), v2 fails over to v1 (DTMF preamble).
v1 fails over to v0 (broker coordination). The agent never crashes —
it just falls back to a noisier discovery.

### 2.2 Sub-audible audio watermark

Phone audio is band-limited to ~300–3400 Hz (G.711, the codec used on
every PSTN call). Below 300 Hz, audio is mostly stripped. Above 3400 Hz
it's filtered out. So traditional "ultrasonic watermark" approaches
(used in retail by Shopify / Disney's old Aurasma) don't work on phone
calls.

But there IS a window: the *very* low end (200–300 Hz) is attenuated
but not removed, and human ears barely distinguish frequencies that low
from background hum. We can encode a few bits of identity there using
spread-spectrum modulation (the same technique CDMA uses) at amplitudes
small enough that humans hear them as ambient noise.

Capacity is tiny — maybe 50–100 bps reliably — but that's enough for a
nonce + protocol version + capability hash in ~1–2 seconds.

**What humans hear:** the call sounds like it has a slightly noisy
background for the first second or two. Indistinguishable from "this is
a cell call in a mediocre coverage area."

**Failure mode:** lossy codecs (G.729, Opus at low bitrates) will
destroy the signal. Detect codec at call start; if it's not G.711, fall
back to v1.

### 2.3 The "polite cover" pattern

Even if v2.1 + v2.2 both fail and we're stuck with the v1 DTMF
preamble, we can make the call sound natural by overlaying the DTMF
under a normal-sounding greeting:

```
"Hi, this is Bella Pizza, how can I help you?"
 ↑                                            ↑
 │ 200ms of audible DTMF tone here (mixed     │
 │ at -20dB under the speech, hidden by       │
 │ voice formants)                            │
```

The agent's TTS audio is generated *with* the DTMF nonce mixed in at a
low level. Humans hear "Hi, this is Bella Pizza" — the DTMF is masked
by the speech. The peer's stream still sees the dtmf events because
the codec preserves the signaling layer.

**What humans hear:** a normal "hello." That's it.

**Failure mode:** mixing too loudly is detectable; too quietly drops
the signal. Needs calibration per codec, per TTS voice.

### Summary of AVIP-2

| Mechanism | What humans hear | Effort | Reliability |
|---|---|---|---|
| SIP custom headers | nothing | Medium (vendor coordination) | High where supported, fails over cleanly |
| Sub-audible watermark | "noisy line" for 1–2s | High (DSP work) | Codec-dependent |
| Polite-cover DTMF | a normal greeting | Low (TTS mixing only) | High (just hides v1 better) |

All three coexist — the agents try them in order and fall back when one
doesn't carry. By v2 done well, **a human listening to any agent
↔ agent call hears two agents being polite. Nothing more.**

---

## AVIP-3 — Trust and federation

**Goal:** any AVIP-aware agent on the internet recognises any other AVIP
agent by identity, with HMAC-grade confidence that the identity is real.

By v3 we have multiple brokers across providers, multiple agent
domains, and a question: how does pizza_shop@bellapizza.example.com
verify that the other side is really `vendor@mumbaifresh.example.com`
and not an impostor?

### 3.1 Per-domain well-known endpoint (DKIM-style)

Every domain that hosts AVIP agents publishes:

```
GET https://example.com/.well-known/avip
```

Returns:

```json
{
  "version": "avip-3",
  "agents": [
    {
      "id": "pizza-shop@example.com",
      "capabilities": ["produce_order_v2", "bill_settle_v1"],
      "pubkey": "-----BEGIN PUBLIC KEY-----\n…",
      "broker": "https://broker.example.com"
    }
  ]
}
```

This is the equivalent of DKIM (which puts an email-signing public key
in DNS): the agent's domain hosts their public key at a well-known URL.
Anyone wanting to verify their identity can fetch it over HTTPS.

### 3.2 Signed nonces

Every preamble (DTMF or SIP-header) carries a signature alongside the
nonce:

```
nonce     = random 8 digits
timestamp = current second-precision UTC
fingerprint = first 4 hex of HMAC-SHA256(nonce || timestamp || from_did, agent_private_key)
```

The peer:
1. Reads the preamble.
2. Pulls the agent's `id` from the call signaling (SIP From: header
   or AVIP-2 X-AVIP-Agent-Id, or the broker session metadata).
3. Fetches `https://<id-domain>/.well-known/avip` (cached for 1 hour).
4. Verifies the HMAC fingerprint with the published public key.
5. Only pairs if the signature checks out.

### 3.3 Capability negotiation

The first message after pairing carries a capability list. The agents
exchange:

```json
{ "type": "hello", "from": "pizza-shop", "capabilities":
    ["produce_order_v2", "bill_settle_v1"] }
```

If they share at least one capability, the higher one of them (by
lexicographic version) becomes the active protocol. If not, the agents
gracefully fall back to voice mode and have a normal conversation —
they can't speak each other's "language" structurally, so they speak
English.

### What this unlocks

- An agent built today can talk to an agent built five years from now
  using v7 of `produce_order` — they just fall back to `produce_order_v2`.
- A new agent vendor (Bland, Vapi, Retell, etc.) implements AVIP and is
  instantly compatible with the entire installed base.
- Spoofing requires compromising the agent's domain — the same security
  model as TLS and DKIM. Hard, well-understood, and outside the
  protocol itself.

---

## AVIP-4 — Skip the PSTN entirely

**Goal:** when both endpoints are AVIP-aware, don't burn PSTN minutes
at all. Go direct.

By v4, agents publishing at `/.well-known/avip` also advertise a direct
WebSocket endpoint:

```json
{
  "id": "pizza-shop@bellapizza.example.com",
  "direct_wss": "wss://agent.bellapizza.example.com/avip/v4"
}
```

When pizza_shop wants to talk to produce_vendor:

1. Pizza_shop's middleware looks up `produce_vendor@mumbai.example.com`
   at the well-known URL.
2. Finds a `direct_wss` field → connects to it directly, exchanging the
   same hello / intent / reply / commit / bye messages as today's
   AVIP-0 data plane.
3. **No PSTN call. No CPaaS. No audio bytes. No TTS. No STT.**
4. Total cost: a couple of LLM calls per side. A couple hundred
   milliseconds end-to-end.

If the lookup fails, or the target's `direct_wss` is unreachable, fall
back to v3 (over PSTN). The voice channel remains the universal
fallback — but it's no longer the default.

### What this looks like at scale

```
                  ┌─────────────────────┐
                  │  AVIP federation     │
                  │  (no central infra) │
                  └──────────┬──────────┘
                             │
        Each agent's domain hosts:
          /.well-known/avip
          wss://.../avip/v4   (direct AVIP-4 endpoint)
          public keys / capabilities / version
                             │
        Discovery + pairing:
          Pizza_shop wants to order from Mumbai Fresh.
          Looks up mumbai-fresh.example.com/.well-known/avip.
          Opens WS, sends signed intent.
          Mumbai Fresh's agent replies. Deal done. Done in ~200ms.
                             │
        Audio fallback:
          Only used when one side is human-only, or when the
          remote agent doesn't have a direct_wss configured.
```

A call that used to take 45 seconds and cost $0.30 now takes 0.2
seconds and costs $0.005. Phone networks become a *last resort*
specifically reserved for human-in-the-loop scenarios.

---

## How the four versions fit together

```
        ╔══════════════════════════════════════════════════════╗
        ║              How an agent reaches its peer           ║
        ╠══════════════════════════════════════════════════════╣
        ║                                                      ║
        ║  1. Try DIRECT (AVIP-4)                               ║
        ║     ─ lookup .well-known/avip                         ║
        ║     ─ if found AND direct_wss reachable:             ║
        ║         open WS, exchange signed AVIP-3 messages      ║
        ║         done — no phone call.                        ║
        ║                                                      ║
        ║  2. Fall back: dial via PSTN (AVIP-3 over voice)      ║
        ║     During call setup:                               ║
        ║       try SIP custom headers (AVIP-2.1)               ║
        ║       try sub-audible watermark (AVIP-2.2)            ║
        ║       try DTMF preamble (AVIP-1)                      ║
        ║       try broker coordination (AVIP-0)                ║
        ║                                                      ║
        ║     First one that produces a paired session wins.   ║
        ║     The voice channel stays open for fallback to     ║
        ║     STT/LLM/TTS if the peer turns out to be human.   ║
        ║                                                      ║
        ╚══════════════════════════════════════════════════════╝
```

Backwards compatibility is automatic: every layer falls back to the
next one down. An AVIP-4 agent talking to an AVIP-1 agent → both end up
in v1 mode. An AVIP-2 agent talking to a human keypad → human goes to
voice mode. The lowest common denominator always works.

---

## Order of operations — what to ship when

This is the actual roadmap, in dependency order:

| Step | Work | What it unlocks |
|---|---|---|
| **1** | Implement HMAC signing on the existing `/api/pair` endpoint. Sign with a per-agent shared secret for the demo; switch to per-domain keys later. | Trust before federation. Defeats the "anyone can hit /api/pair and steal a session" issue today. |
| **2** | Wire `/.well-known/avip` on each agent's domain. Static JSON file is fine. | Cross-vendor identity resolution; foundation for everything that follows. |
| **3** | Make AVIP-1 actually run over a real PSTN bridge (deploy a second middleware on a different CPaaS, dial across, watch the in-band nonces cross). | Proves cross-vendor protocol. |
| **4** | Move discovery to SIP custom headers where the path supports them (AVIP-2.1). | Silent handshake on direct-bridged calls. |
| **5** | Implement capability negotiation in the hello message; let the agents pick the highest mutual schema. | Forward-compatibility — new schemas don't break old agents. |
| **6** | Add the polite-cover TTS mixing for the DTMF preamble (AVIP-2.3). | Silent handshake even on PSTN paths that strip SIP headers. |
| **7** | Ship the direct-WSS endpoint (AVIP-4). | PSTN becomes a fallback, not the default. Cost drops 50×. |
| **8** | Sub-audible watermark (AVIP-2.2). | Belt-and-braces invisibility on lossy paths. |

Steps 1–3 are weeks of work. Steps 4–6 are a month. Steps 7–8 are a
month each. The first three give us a real protocol. The rest are the
"make it pleasant" layers.

---

## Open questions

These are real engineering decisions we don't have answers for yet:

1. **Who hosts the well-known endpoint for a number that doesn't have a
   domain?** (i.e., a Twilio DID with no public website behind it.)
   Probably a CPaaS-hosted resolver: each CPaaS publishes a wildcard
   `well-known/avip` for all its DIDs.

2. **How do we revoke a compromised agent identity?** Short-lived
   well-known endpoints + a revocation list. Same model as TLS CRLs.

3. **What about backward-compatible voice fallback when the peer is a
   v0 agent but we're a v3?** The v3 agent emits everything (SIP
   headers, watermark, DTMF, broker registration) — the v0 agent only
   sees the broker pairing, which still works. v3 always wins
   downwards.

4. **Capability schemas — how versioned, who governs?** OpenAPI-style
   schemas under `/.well-known/avip/schemas/...`, hosted per-domain.
   Vendors can publish their own, and overlapping vendors can converge
   on shared ones (like email RFCs).

5. **What happens to the cosmetic modem audio in AVIP-2+?** Drop it.
   The point of cosmetic modem chirps was "make humans hear something
   so they know the agents are talking" — but in AVIP-2 we *want*
   humans to hear nothing. The voice channel goes silent during the
   data exchange, and the agents resume speaking when they have
   something to say (or when a human joins).

6. **How do we handle a partial v2 fallback — one side speaks AVIP-2,
   the other only AVIP-1?** The v2 agent emits its SIP headers AND
   plays the DTMF preamble (it costs nothing extra). The v1 agent
   ignores the headers and pairs on DTMF. Both get a session; one
   side just hears more than the other.

---

## What success looks like

By the time AVIP-4 ships, the demo looks like this:

```
You click "Trigger demo."

Dashboard:
  ╭────────────────────────────────────────╮
  │  Agent ↔ Agent  ·  AVIP-4 direct  ·  ✓  │
  │                                         │
  │  Voice time:    0.0s  (never opened)   │
  │  Data time:     0.18s                   │
  │  Latency saved: 47.2s vs voice baseline │
  │  Cost saved:    $0.34  (99% off)        │
  ╰────────────────────────────────────────╯

  Data plane:
    pizza_shop → vendor: {type:"intent", name:"order", ...}
    vendor → pizza_shop: {type:"confirm", total_inr:2235, ...}
    pizza_shop → vendor: {type:"commit", payment_token:"…"}
    vendor → pizza_shop: {type:"bye"}

  Voice plane: (empty — no audio channel ever opened)
```

The phone network becomes the human-fallback layer. Agents talk to
agents at the speed of the internet.

That's the long arc. v0 is the seed.
