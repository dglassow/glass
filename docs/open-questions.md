# Glass — open questions

Everything settled lives in `glass-plan.md`. This file is only what's still undecided.

**Ordered by when it blocks you.** Each has my recommendation where I have one, so most can be answered with a yes or a swap.

**Numbering is compacted** each time settled items are cleared, so IDs refer to the current version of this file.

Types: **Decide** = needs your call · **Find out** = needs a spike first · **Do** = not a question, just work

---

## Index

| ID | Type | Question | My lean |
|---|---|---|---|
| **Q1** | Do | App Store Connect API key for notarization | in progress |
| ~~Q2~~ | ~~Find out~~ | ~~Does `@simplewebauthn/server` fit the passkey flow?~~ | **resolved ✓** |
| **Q3** | Find out | Does Etch have a programmatic mode with structured output? | deferred |
| **Q4** | Find out | whisper.cpp or faster-whisper, on which Mac? | spike |
| **Q5** | Find out | Message format for streaming text + audio | design later |
| **Q6** | Later | Order of the deferred Mac capabilities | automation last |

---

## Phase 2 — Identity and remote access

### Q1 — Apple Developer Program setup
**Do.** $99/year. Without it Gatekeeper blocks the app on every Mac except the one that built it.

You mentioned you may already have this and want a step-by-step walkthrough — say the word and I'll write it out. Enrollment has approval lead time, so worth starting before Phase 2 rather than during.

---

### Q2 — Does `@simplewebauthn/server` fit the passkey flow?
**Resolved ✓ (Phase 2 M2).** Verified with a full headless ceremony (register +
authenticate) on Node 25 and wired into the hub (`packages/hub/src/passkey.ts`),
gated by `--register-token`, with a passkey session granted enrollment-approver
capability. Proven by `tests/p2m2-passkey.mjs`. Browser-side wiring
(`navigator.credentials` in the viewer) still needs real-device verification.

---

## Phase 5 — Chat and voice

### Q3 — Does Etch have a programmatic mode with structured output?
**Find out.** *(Deferred — Phase 5, nothing before it depends on this.)*

Interactive Etch needs nothing from Glass; it's a program in a PTY. But the PWA chat has to invoke Etch, get something parseable back, and render it conversationally.

- **If Etch has a non-interactive mode** emitting JSON or similar — the chat surface is straightforward subprocess invocation.
- **If Etch is purely a TUI** — cursor positioning, ANSI redraws — Glass would be scraping a terminal UI, which is fragile, and the fix lands in Etch rather than Glass.

Worth knowing before Phase 5 planning gets specific, since the second case is a meaningfully larger job.

---

### Q4 — Which speech-to-text engine, on which Mac?
**Find out.** whisper.cpp and faster-whisper are both credible. Needs a real latency test on your hardware with your audio — a spike, not a reading exercise.

Note the input constraint: iPhone audio arrives from WebKit, so whatever format Safari's recorder produces has to feed this pipeline cleanly.

---

### Q5 — Message format for streaming text and audio
**Find out.** The wire format carrying text deltas and audio between the PWA and Hub. Shape depends on Q3 — structured Etch output makes this much simpler. Not worth specifying in the abstract.

---

## Later

### Q6 — Order of the deferred Mac capabilities
**Later.** Automation (controlling other apps), file transfer, clipboard sync.

Automation needs a separate macOS permission grant on every device and is the big one. File transfer and clipboard sync are small — new message types on infrastructure you'll already have.
