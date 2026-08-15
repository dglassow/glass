# Multi-agent control plane

Glass runs Etch, Codex, Claude, and explicitly configured generic CLIs side by
side. Etch is the default and reference provider. Glass detects installed
providers; it never installs, updates, configures, or bundles them.

## Ownership and survival

```text
Hub                 durable run/workspace metadata only
  ↕
Agent               authenticated routing and reconstructible subscriptions
  ↕
sessiond            live provider processes, streams, queues, and run snapshots
  ├─ etch surface --stdio
  ├─ codex app-server --stdio
  ├─ claude --print --output-format stream-json
  └─ configured generic argv
```

Viewer and Agent replacement do not stop live runs because the processes live
in `sessiond`. The Hub stores bounded control metadata and layouts, not prompts,
responses, approvals, commands, tool payloads, or transcripts. Content events
are routed only to viewers that explicitly subscribe to a run.

## Agent Board

Open **Agent Board** from the Viewer toolbar. Etch is selected by default. The
board provides:

- **Needs you**, **Active**, and **Finished** lanes as one attention inbox;
- device/provider/cwd/profile/model/reasoning launch controls;
- a content-free Doctor report for backend lifecycle and provider readiness;
- streamed output, tool/delegation events, usage, and status;
- approval, clarification, interrupt, close, and Etch delegation controls;
- provider-native resume for interrupted runs with retained session ids;
- Etch session/delegation/orchestration inspectors and file attachment;
- durable workspace selection and run grouping across reconnects.

Etch coding runs default to an Etch-owned isolated worktree. Selecting shared
mode is explicit. Etch creates and locks its worktree and remains responsible
for recovery, merge, and cleanup policy.

## Provider behavior

| Provider | Primary adapter | Reduced behavior |
|---|---|---|
| Etch | Versioned `etch surface --stdio`: lifecycle, streaming, input, delegation, orchestration, usage, attachments, profiles/models, and worktrees | Older Etch automatically uses `etch -z` and advertises `oneshot,reduced` |
| Codex | `codex app-server --stdio`: persistent thread, streaming, approvals/input, interrupt, and usage | Falls back to resumable `codex exec --json` and advertises `reduced` |
| Claude | Resumable streaming JSON CLI | Interactive-only behavior remains provider-limited and is shown by capabilities |
| Generic | Owner-configured argv with stdout streaming and interrupt | No structured session, approval, delegation, or attachment APIs |

Provider differences are reported as capabilities; Glass does not emulate a
missing permission or lifecycle feature.
Agent registration probes each public command surface and reports the adapter
Glass actually proved usable: structured, reduced, generic, or unavailable.
Binary presence alone is not treated as readiness.

## Restart reconciliation

Every successful Agent registration requests a content-free inventory from its
own sessiond instance.
The Hub compares that authoritative live inventory with durable run cards.
If sessiond restarted, formerly active records that are no longer live become
`interrupted` instead of remaining indefinitely in Active or Needs you.
The Agent Board can start a new Glass run through the provider's resume path
when an interrupted record retained a provider session id.

Routine Viewer, app, Hub, and Agent replacement still leaves sessiond and its
provider children running.
An explicit sessiond restart is destructive until live daemon handoff exists.

## Configuration

Binary overrides are local backend configuration:

```sh
GLASS_ETCH_BIN=/path/to/etch
GLASS_CODEX_BIN=/path/to/codex
GLASS_CLAUDE_BIN=/path/to/claude
GLASS_GENERIC_AGENT_ARGV='["/path/to/agent","--stream"]'
```

The Viewer cannot choose an executable or inject environment variables.
Generic configuration is a JSON argv array and is launched without a shell.

For Etch status compatibility, Glass supplies both `GLASS_*` and legacy
`PRISM_*` schema-v2 status variables. Structured provider events take
precedence; status files are content-free and per-run.

## Protocol

The normalized `run.*` family covers create/list/subscribe/snapshot, submit,
respond/control, queries, file attachment, normalized events, and metadata
updates. `workspace.*` stores Agent Board layout and membership. Provider-native
wire types remain inside their `sessiond` adapter.

Run records may contain provider/session ids, cwd, launch selections, Etch
worktree references, capability names, normalized state, aggregate usage/cost,
and timestamps. They must never contain transcript content.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @glass/viewer build:lib
node tests/p9m1-agent-runs.mjs
node tests/p9m2-mixed-providers.mjs
corepack pnpm test:providers -- --runs
```

The harnesses cover Etch streaming/delegation/status aliases, durable workspaces,
reduced-mode fallback, Agent replacement, concurrent Codex/Claude execution,
attention/approval isolation, failure isolation, Agent-only metadata publishing,
subscriber-only content routing, sanitized usage metadata, and Hub-store
privacy.
The opt-in live smoke uses the installed Etch, Codex, and Claude binaries,
starts them concurrently through the full stack, replaces Agent, and requires
all three to complete unattended.
