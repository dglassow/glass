# Glass extensions

Extensions are small user-authored add-ons for the viewer, VS Code-style but
adapted to Glass's trust posture. An extension is a single JSON file anyone
can write in a text editor; it's installed from the app (ribbon ⋯ →
**Extensions…** → Import, paste or open the file) and its code runs sandboxed
inside Glass.

## Trust model

Installing an extension is choosing to run its code — the install step is the
consent step. Before anything is stored or run, Glass shows exactly the
capabilities the manifest declares; a file declaring a capability this Glass
version doesn't know **refuses to import** (fail closed — the dialog must
never under-report a grant).

The code runs in a dedicated **Web Worker**, never in the page:

- no DOM, no viewer localStorage (where the device identity key lives), no
  Tauri IPC bridge;
- its only bridge to Glass is a message-passing RPC, and every method is
  gated on the granted capabilities — deny by default, unknown methods
  refused;
- everything the worker sends to the host is structurally validated and
  bounded before it's acted on.

What the sandbox does **not** confine: a worker still has the platform's own
`fetch`. Capabilities gate what an extension can *see and do in Glass*; only
install extensions from sources you trust.

Extensions live per device (localStorage), like skills. They are not synced,
not part of the backup bundle, and never leave the device.

## File format

```json
{
  "glassExtension": 1,
  "id": "session-counter",
  "name": "Session counter",
  "version": "1.0",
  "icon": "𝚺",
  "description": "A ribbon button that reports how many sessions are open.",
  "capabilities": ["sessions.read", "notify"],
  "code": "glass.ribbon.add({ id: 'count', title: 'Count sessions', icon: '𝚺', onClick: async () => { const list = await glass.sessions.list(); await glass.notify(`${list.length} session(s) open`); } });"
}
```

- `glassExtension` — format version, must be `1`.
- `id` — stable identity: 1–64 chars of `a-z 0-9 . _ -`, starting
  alphanumeric. Re-importing the same id replaces the installed version.
- `name` (≤64), `version` (≤32), `icon` (≤8 chars, optional),
  `description` (≤512, optional).
- `capabilities` — array drawn from the catalog below; omit or `[]` for a
  UI-only extension.
- `code` — plain JavaScript (≤128 KiB), the body of a classic worker script:
  no `import`, no DOM. It runs once at startup of each enabled extension.

## Capabilities

| capability       | grants                                                        |
| ---------------- | ------------------------------------------------------------- |
| `sessions.read`  | see the session list and read terminal output                 |
| `sessions.write` | type into the focused session (exactly like the keyboard — the skills trust model) |
| `storage`        | keep its own key/value data on this device (namespaced, ≤64 KiB) |
| `notify`         | show messages in the status line                              |

Ribbon buttons are capability-free: an inert button whose click is delivered
back to the extension. The set is deliberately small; more capabilities land
as needs appear, and old extensions keep working (grants are checked by name).

## API

The worker gets one global, `glass`. All RPC methods return promises and
reject with the host's refusal reason (unknown method, ungranted capability,
bad arguments).

```js
// Ribbon (no capability): add a button; the title shown to the user is
// suffixed with the extension name. Max 8 buttons per extension. Freshly
// installed extensions' buttons auto-pin; on later launches the user's
// pin/unpin arrangement is respected.
glass.ribbon.add({ id: "btn", title: "Do it", icon: "★", onClick: () => {} });

// sessions.read
const list = await glass.sessions.list();
//   [{ sessionId, agentId, title, focused, visible }, …]
glass.sessions.onOutput((sessionId, data) => { /* live output stream */ });

// sessions.write — sends to the CURRENTLY FOCUSED session, exactly like
// typing; no focused session means a no-op. Append "\n" yourself to run.
await glass.sessions.type("git status\n");

// storage — per-extension, JSON values; set undefined to delete a key.
await glass.storage.set("key", { any: "json" });
const v = await glass.storage.get("key"); // undefined when absent

// notify
await glass.notify("done");

// Debug logging (no capability): shows in the devtools console as [ext:<id>].
glass.log("hello");
```

## Authoring workflow

Write the JSON file, paste it into **Extensions…** → Import → Review →
Install. Iterate by re-importing (same `id` replaces in place; the worker
restarts with the new code). Disable via the checkbox in the list; Delete
also drops the extension's stored data. Errors thrown by extension code
surface in the status line and never affect the rest of the app.
