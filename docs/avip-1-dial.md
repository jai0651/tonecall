# AVIP-1 — the Dial-bridge topology (current code)

> This doc describes the topology shipped after the hackathon, replacing
> the `<Conference>` design documented in `architecture.md` §3/§5. Where
> the two disagree, THIS doc is current.

## What changed and why

The hackathon build paired agents through **shared middleware state**: both
legs joined a `<Conference>` on Provider A and the broker matched them on a
deterministic conference name. That worked, but it wasn't a protocol — it
only paired agents that happened to land on the same process, and the
conference mixer physically blocked the in-band DTMF handshake (the
portable path) from ever running on a real call.

AVIP-1 removes the conference entirely:

```
/api/trigger-call
   │  originate ONE call: callerId → DID_A
   ▼
DID_A's app (this middleware) answers:
   <Stream wss://…/voice/A/> + <Dial><Number>DID_B</Number></Dial>   ← initiator leg
   │
   ▼
DID_B's app (any middleware, any vendor) answers:
   <Stream wss://…/voice/B/> + <Wait/>                               ← responder leg
   │
   ▼
Provider A bridges the legs over real PSTN/SIP. Audio AND DTMF cross
end-to-end — verified by the dial-dtmf probe (branch `dial-dtmf`):
all 13 preamble digits sent on leg A arrived on leg B's stream.
```

Historical note: the hackathon-era "same-account `<Dial>` hits Ring
Timeout" finding was a self-inflicted wound — the dialed DID's Application
returned `<Conference>` XML, which broke the bridge. With the callee
answering `<Stream>+<Wait>`, the bridge comes up cleanly.

## Pairing is now always in-band

`stateMachine.ts` runs ONE handshake on every real call:

| Role (from dialRegistry) | Behaviour | Window |
|---|---|---|
| **initiator** — the leg that `<Dial>`ed out | Plays `9090<nonce>#` at ~0.5s, re-emits every 4s (early bursts are lost while the peer is still ringing) | 20s (`INITIATOR_HANDSHAKE_TIMEOUT_MS`) |
| **responder** — dialed-into / inbound leg | Silent until it HEARS a preamble, then answers with its own | 8s (`HANDSHAKE_TIMEOUT_MS`) |

Consequences:

- A human calling one of our DIDs never hears unsolicited beeps — the
  responder never emits first. After 8 silent seconds they get the normal
  voice greeting. (The conference-era code actually **hung up** on human
  callers after a 15s pair timeout; that bug is gone.)
- Cross-vendor works by construction: the signal rides the call itself.
  An agent on any other CPaaS provider that plays the same grammar pairs with us.

Both sides then submit cross-wise nonces to the broker (`/api/pair`) and
get the same sessionId. When `AVIP_PAIR_SECRET` is set, submissions carry
an HMAC-SHA256 signature over `callUuid|myNonce|peerNonce|agentNumber|ts`
with a 30s replay window (`src/lib/pairAuth.ts`) — an eavesdropper who
hears the audible preamble can no longer steal the session.

## Federated two-middleware mode — the default demo

Each middleware owns ONE agent; they share nothing but the broker URL and
the pair secret. This is the honest demo: two independent runtimes that
discover each other over the phone network.

```
┌──────────── instance A (leader + broker) ───────────┐   ┌──────── instance B ────────┐
│ AGENT_OWNED=vegetable_vendor                          │   │ AGENT_OWNED=pizza_shop      │
│ PORT=3000, PUBLIC_HOST=tunnelA                        │   │ PORT=3001, PUBLIC_HOST=tunnelB
│ (BROKER_URL unset → this process IS the broker)       │   │ BROKER_URL=https://tunnelA  │
│ AVIP_PAIR_SECRET=<shared>                              │   │ FORWARD_EVENTS_TO=https://tunnelA
│                                                       │   │ AVIP_PAIR_SECRET=<shared>    │
│ DID_A's Application → tunnelA/api/answer              │   │ DID_B's Application → tunnelB/api/answer
└───────────────────────────────────────────────────────┘   └─────────────────────────────┘
```

Run it locally (stubs, no provider cost):

```bash
npm run dev:a          # terminal 1 — vegetable_vendor + broker on :3000
npm run dev:b          # terminal 2 — pizza_shop on :3001, brokered by :3000

# trigger a federated simulated call (leg A here, leg B on the peer):
curl -X POST http://localhost:3000/api/simulate \
  -H 'Content-Type: application/json' \
  -d '{"peerBase":"http://localhost:3001"}'
```

Watch the dashboard on :3000 — instance B forwards its events there
(`FORWARD_EVENTS_TO`), so one screen shows both sides.

Live over the provider network: same two processes behind two tunnels, each DID's
Application pointing at its own middleware, then click **Trigger** (or
POST `/api/trigger-call`) on instance A. Instance B needs no notice at
all — its DID simply receives a call and hears the preamble.

After pairing, each instance drives its own leg (`runSoloPairedMode`):
LLM-generated voice intro on its own leg (audible to the peer across the
bridge), the JSON exchange over the broker's `/data/:sessionId` relay
(initiator opens with `hello`, strict turn alternation), a spoken
goodbye summarizing the deal, then hangup.

The single-process mode (no `AGENT_OWNED`) still exists for one-box dev
and keeps the centralized 4-phase orchestrator with its cost/latency
metrics.

## Env quick-reference (new/changed)

| Var | Meaning | Default |
|---|---|---|
| `AGENT_OWNED` | The one agent this middleware represents | unset = both |
| `BROKER_URL` | Broker base for /api/pair + /data WS | unset = self |
| `FORWARD_EVENTS_TO` | Leader middleware for dashboard events | unset |
| `AVIP_PAIR_SECRET` | Shared HMAC secret for /api/pair | unset = open pairing |
| `AVIP_PAIR_MAX_SKEW_MS` | Replay window for signed pairs | 30000 |
| `HANDSHAKE_TIMEOUT_MS` | Responder listen window | 8000 |
| `INITIATOR_HANDSHAKE_TIMEOUT_MS` | Initiator window (covers Dial ring) | 20000 |
| `PREAMBLE_INTERVAL_MS` | Initiator re-emit interval | 4000 |
| `CALLEE_WAIT_SEC` | `<Wait>` length on responder legs | 600 |
| `DIAL_TIMEOUT_SEC` | `<Dial>` ring timeout | 30 |

## What's gone

- `<Conference>` XML, `conferenceRegistry`, `pairByConference`, the
  `/api/peer-notify` coordination endpoint — the entire
  shared-coordination pairing surface.
- The alphabetical initiator/responder tie-break (roles now come from the
  call topology, so they're consistent across middlewares).
- The cosmetic modem chirps in federated mode (they'd cross the real
  bridge and garble the peer's audio; the roadmap wanted them gone anyway).

## Still open (next steps on the roadmap)

- Real cross-vendor PSTN test (Provider A ↔ Provider B) — the code path is the one
  exercised by the federated simulator; needs a deployment, not a change.
- SIP-header discovery (AVIP-2.1) and TTS audio watermarking to replace the
  audible preamble.
- Per-domain keys at `/.well-known` (AVIP-3) replacing the shared secret;
  align the data plane with Google's A2A agent-card schema.
- Redis-backed registries for restart safety.
