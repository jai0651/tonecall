# Tonecall — Docs

Internal reference set. Six docs + one runnable deck. Each one written
for a specific reader, picked from the table below.

```
docs/
├── README.md                              ← you are here
├── deep-dive/index.html                   ← GRANULAR how-it-works: 7 linked HTML pages (open in a browser)
├── avip-1-dial.md                          ← CURRENT topology: Dial bridge + in-band pairing + federation runbook
├── protocol.md                            ← what AVIP-0 was + how to talk about it (partially superseded)
├── architecture.md                        ← the hackathon build (partially superseded)
├── future-protocol.md                     ← v1 → v4 roadmap (AVIP-1 is now shipped)
├── demo.md                                ← live-demo playbook
├── slides.html                            ← reveal.js deck (open in browser)
├── inter-agent-voice-handshake.md         ← original design doc (history)
└── inter-agent-handshake-skeleton.py      ← original FastAPI skeleton (history)
```

---

## What each doc is for

| File | Reader | Length | Read it when |
|---|---|---|---|
| **`protocol.md`** | You, on stage | 10 min | Before going on stage — quote-cards for AI-vs-human detection, the 4 protocol parts, the evolution path. The most condensed map. |
| **`architecture.md`** | New engineer joining the project | 30 min | Onboarding. Plain-English voice primer + the 9 sections covering current code (file map, env vars, glossary). |
| **`future-protocol.md`** | Anyone asking "what's next?" | 20 min | Roadmap conversations. AVIP-1 → AVIP-4 with mechanism, what humans hear, and engineering effort per version. |
| **`demo.md`** | You, prepping for stage | 15 min | The hour before the demo. Pre-flight checklist, beat-by-beat narration, failure recovery, FAQ + deep Q&A. |
| **`slides.html`** | Audience | live | The demo itself. 10 reveal.js slides; open in browser, press F for fullscreen, S for speaker notes. |
| **`inter-agent-voice-handshake.md`** | Curious / historian | 45 min | If a judge asks "where did this idea come from?" — this is the original handshake design doc with the full voice-protocol primer. |
| **`inter-agent-handshake-skeleton.py`** | n/a | n/a | Python FastAPI skeleton from the original design doc. **Not actually used** — the runtime is in `src/`, TypeScript. Kept for reference. |

---

## Suggested reading orders

### "I have 10 minutes before the demo"

→ `protocol.md` (read all)
→ `demo.md` §1 (pitch) + §2 (live demo script)
→ `slides.html` (skim, then open in Chrome and press F)

### "I'm new — what is this whole thing?"

→ `protocol.md` §1 (the one-sentence pitch) + §2 (the 4 protocol parts)
→ `architecture.md` §0 (30-second pitch) + §3 (step-by-step trigger
   walkthrough)
→ `future-protocol.md` to see where it's going

### "I'm an engineer who wants to read the code"

→ `architecture.md` end-to-end (it's written for you)
→ Then `src/ws/stateMachine.ts` (the heart of the protocol)
→ Then `src/ws/demoFlow.ts` (the orchestrator)
→ `future-protocol.md` if you want to know what to ship next

### "I'm a judge who wants to vote yes"

→ `protocol.md` (concise — what it is, how it works)
→ `architecture.md` §6 (the metrics: real numbers from real runs)
→ `future-protocol.md` §"AVIP-2" (the silent handshake — the
   headline UX moment)

---

## Live state of the repo

- **Demo path**: real Plivo + real OpenAI on `npm run dev` with
  `USE_STUBS=false`. UI button at `/` POSTs `/api/trigger-call`.
- **Verified working metrics** (real Plivo run from this hackathon):
  voice 64 s · data 13 s · latency saved 61 s · cost saved $0.25.
- **AVIP-1 readiness**: the in-band-nonce-over-Dial path is proven
  (probe at `/api/trigger-dial-probe` saw 9/9 DTMF digits cross the
  bridge). The refactor to ship it as the default is documented but
  not merged for the hackathon demo.

---

## Conventions in these docs

- Diagrams are **ASCII**, not images. Plays well on any terminal /
  rendered Markdown viewer / printed PDF. Avoids broken image links.
- Code paths are **prefixed with `src/`**, full from the repo root.
- Phone numbers are written `+1AAAAAAAAAA` (E.164, no spaces or dashes).
- Voice-protocol jargon is **defined the first time it appears** and
  has a glossary at the bottom of `architecture.md`.
- Every claim that depends on a Plivo experiment includes the result
  inline (e.g., "verified — 9/9 digits crossed"). No hand-waving.
