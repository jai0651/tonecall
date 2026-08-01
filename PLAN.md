# Build Plan

Hackathon-scope. ~8 phases. Single Next.js + custom-server process.

## Phase 1 — Scaffold ✅
- Next.js 15 + TypeScript + Tailwind
- Custom `server.ts` with `ws` for WebSockets
- Config files, env example, README, PLAN.md

## Phase 2 — Plivo answer URL + voice WebSocket
- `POST /api/answer/[number]` returns `<Stream>` XML
- WS `/voice/:call_uuid` accepts, parses `start`/`media`/`dtmf`/`stop`
- AGENT_CONFIGS dict keyed by phone number

## Phase 3 — Handshake state machine
- Generate 8-digit nonce
- Emit DTMF preamble via Plivo `send_digits`
- Listen for peer preamble with 1.5s timeout
- State: HANDSHAKING → PAIRED or VOICE

## Phase 4 — Broker + data WebSocket
- `POST /api/pair` — match nonces cross-wise, return session_id
- WS `/data/:session_id` — relay JSON between two peers
- In-memory state (Map, no DB)

## Phase 5 — Paired-mode LLM loop
- OpenAI chat-completions wrapper with JSON-shaped I/O
- `runAgentOverJson(dataWs, config)` loop
- Cosmetic modem-chirp audio pump on voice WS

## Phase 6 — Voice fallback loop
- Stubbed STT consumes inbound audio frames
- LLM text mode
- Stubbed TTS produces outbound audio frames
- Frame helper splits into 20ms mu-law chunks

## Phase 7 — Demo UI dashboard
- `/` — split-screen comparison
- Trigger button → `POST /api/trigger-call`
- SSE `/api/events` feeds live JSON + simulated transcript
- Timer + cost comparison

## Phase 8 — Real Plivo wiring
- Plivo SDK client, env-gated stub/real
- README run instructions

## Out of scope (post-hackathon)
- Persistent storage / multi-instance broker (use Redis)
- Real STT (Deepgram streaming)
- Real TTS (ElevenLabs streaming)
- HMAC auth on broker pair endpoint
- Cross-vendor federation
- Open AVIP-0 spec PDF
