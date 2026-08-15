# Glass — open questions

Everything settled lives in `plan.md`. This file is only what's still undecided.

**Ordered by when it blocks you.** Each has my recommendation where I have one, so most can be answered with a yes or a swap.

**Numbering is compacted** each time settled items are cleared, so IDs refer to the current version of this file.

Types: **Decide** = needs your call · **Find out** = needs a spike first · **Do** = not a question, just work

---

## Index

| ID | Type | Question | My lean |
|---|---|---|---|
| ~~Q1~~ | ~~Do~~ | ~~App Store Connect API key for notarization~~ | **resolved ✓** |
| ~~Q2~~ | ~~Find out~~ | ~~Does `@simplewebauthn/server` fit the passkey flow?~~ | **resolved ✓** |
| ~~Q3~~ | ~~Find out~~ | ~~Does Etch have a programmatic mode with structured output?~~ | **resolved ✓** |
| **Q4** | Find out | whisper.cpp or faster-whisper, on which Mac? | spike |
| **Q5** | Find out | Message format for streaming text + audio | design later |
| **Q6** | Later | Order of the deferred Mac capabilities | automation last |

---

## Phase 2 — Identity and remote access

### Q1 — Apple Developer Program setup
**Resolved ✓.** Program active, Developer ID Application cert issued (plan §15),
and notarization is operational: `packages/desktop/sign-and-notarize.sh`
signs + notarizes + staples the app and dmg via the `glass-notary` notarytool
Keychain profile. Signed, notarized Glass.dmg artifacts ship via the hub's
updater endpoint (Phase 8).

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
**Resolved ✓ (Phase 9 review).** Etch has three usable surfaces: (1) `etch -z`
one-shot final text, which is the current compatibility baseline; (2) the
versioned `etch-surface-v1` JSON-RPC gateway over stdio/WebSocket, which is the
chosen Glass integration; and (3) ACP, which remains available for editor and
generic agent-client integrations but is not Glass's primary path.

Etch now ships the supported `etch surface --stdio` launcher. The versioned
surface covers session create/resume/activate/close, streaming, approvals,
clarification, session information, commands, file attachment, active sessions,
delegation events/control, orchestration status, usage, and worktree metadata.
Glass negotiates these optional capabilities and never launches internal Python
modules or binds to private gateway names. Older Etch versions remain supported
through a visibly reduced `etch -z` adapter. See plan §6 and Phase 9.

---

### Q4 — Which speech-to-text engine, on which Mac?
**Find out.** whisper.cpp and faster-whisper are both credible. Needs a real latency test on your hardware with your audio — a spike, not a reading exercise.

Note the input constraint: iPhone audio arrives from WebKit, so whatever format Safari's recorder produces has to feed this pipeline cleanly.

---

### Q5 — Message format for streaming text and audio
**Find out.** Provider text deltas and input requests now normalize through the
Phase 9 adapter contract. The remaining design question is the audio envelope
between WebKit, the Hub, and the selected STT/TTS worker. Specify it after the
Q4 hardware/codec spike rather than in the abstract.

---

## Later

### Q6 — Order of the deferred Mac capabilities
**Later.** Automation (controlling other apps), file transfer, clipboard sync.

Automation needs a separate macOS permission grant on every device and is the big one. File transfer and clipboard sync are small — new message types on infrastructure you'll already have.
