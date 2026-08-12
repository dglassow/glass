# Kickoff prompt for Claude Code

Paste this as the first message of the first session.

---

Read `CLAUDE.md`, `docs/plan.md`, and `docs/open-questions.md` before doing anything. They're the result of a long design conversation and everything not listed as an open question is already decided.

Then, before writing code, tell me back in a few sentences:
1. Why PTYs live in `sessiond` rather than the worker
2. Why browsers aren't session kinds
3. What `@glass/protocol` is allowed to depend on, and what's allowed to depend on it

If any of those don't land, the design docs need fixing before we build on them.

## First task

Finish Phase 0 by scaffolding the process topology from plan §3 — `supervisor`, `sessiond`, `agent`, `hub` as workspace packages with correct dependency boundaries. Skeletons only; no behavior yet. The point is that Phase 1 code can't accidentally land in the wrong tier.

## Then: Phase 1, milestone 1 — the local loop

Before any networking, Hub, or auth, prove the topology actually works on one machine:

- `sessiond` spawns a PTY and exposes it over a Unix domain socket
- `agent` (worker) connects to `sessiond` and relays I/O using the existing protocol envelopes
- A throwaway CLI client attaches, runs a shell, and shows output

**The acceptance test: kill and restart the worker while a shell is running, and the shell survives with scrollback intact.**

That single test validates the load-bearing assumption in the whole design. If it doesn't hold, everything downstream is wrong and I want to know now rather than in Phase 4. Don't move on until it passes.

Work in small commits, run `pnpm typecheck` before each, and ask before deviating from the plan.
