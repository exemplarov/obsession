# OpenCode Sessions (Obsidian plugin)

Browse your local [OpenCode](https://opencode.ai) **v2** sessions directly in
[Obsidian](https://obsidian.md) — as a dedicated view or as dashboards embedded
in any note — then open any session and watch it **stream in real time**, send
follow-up prompts, and interrupt runs.

![version](https://img.shields.io/badge/version-0.3.0-blue)

OpenCode **v2 only**: the legacy v1 storage backend has been removed. The
plugin talks to the local v2 server's beta HTTP API (`/api/*`), discovered
from `~/.local/state/opencode/service.json`, and reads the v2 SQLite database
(`session_v2`) for listing/fallback. Nothing leaves your machine.

## Features

- **Note-embedded dashboards** via an `opencode-sessions` code block (cards or table layout) — no other plugins required.
- **Dedicated view** (command palette: *Open OpenCode sessions*, or the ribbon icon).
- **Live state tracking** from the v2 beta event stream (`GET /api/event`):
  Running…, Idle, Needs approval, Interrupted, Error — updated the instant they
  change. Falls back to SQLite heuristics when the server is unreachable.
- **Session chat view**: click any session to open it. Messages stream in live
  (text + reasoning + tool calls with input/output), history loads from the API
  with *Load older*, and — via a `flex-direction: column-reverse` trick — new
  content always attaches to the **bottom** of the chat and stays in view.
- **Prompt & stop**: send messages to a session (`POST /api/session/{id}/prompt`)
  and interrupt a running one (`POST /api/session/{id}/interrupt`) right from
  the composer.
- **New sessions**: the *New OpenCode session* command (or the dashboard's
  *New session* button) picks one of your configured directories — a single
  directory is used automatically, several open a card picker — and starts a
  draft chat; the server session is created with your first message.
- Offline fallback: when the server is down, the chat shows the conversation
  read-only from `session_message` (input disabled).
- Also exposes an API (`globalThis.opencodeSessions`) for e.g. Datacore JSX consumers.

## Embed in a note

````markdown
```opencode-sessions
layout: cards
basedir: /Users/roman/
dirs:
  - vaults/my-vault
  - spaces/my-vault
```
````

Options (simple `key: value` lines or a JSON object):

| Option | Default | Description |
| --- | --- | --- |
| `dirs` | plugin setting | Directories to list sessions for. Relative entries resolve against `basedir`. |
| `basedir` | – | Prefix for relative `dirs`; cards/tables show directories relative to it. |
| `layout` | `cards` | `cards` (single-column multi-line cards) or `table`. |
| `pageSize` | plugin setting | Sessions per page (the **Items per page** setting, 10 by default). |
| `title` | – | Optional heading above the dashboard. |

Click a card (or table row) to open the live chat view; click a session ID to copy it.

## Settings

### OpenCode server (v2 API)

- **Server URL override** — leave empty to auto-discover via `~/.local/state/opencode/service.json` (recommended).
- **Server password override** — Basic-auth password; leave empty to use the discovered service credentials.

### Session database (SQLite)

- **OpenCode database** — path to `opencode.db` (default: `~/.local/share/opencode/opencode.db`), `session_v2` table.
- **sqlite3 executable** — usually `/usr/bin/sqlite3` (macOS).
- **Directories** — default directories for dashboards that omit `dirs`.
- **Custom SQL** — optional `WHERE` fragment (validated: no `;` or comments).
- **Refresh interval** — seconds between automatic SQLite refreshes; the event stream refreshes instantly while connected. `0` disables the timer.
- **Items per page** — default page size (10).

## Install (manual)

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/opencode-sessions/`, then enable **OpenCode Sessions**
under Settings → Community plugins. Desktop only (spawns `sqlite3`, talks to the
local OpenCode server).

## API

`globalThis.opencodeSessions` (version 3):

```js
const api = globalThis.opencodeSessions;
const rows = await api.list({ dirs: ["/abs/path"], basedir: "/optional/prefix" });
const unsubscribe = api.subscribe(() => { /* data or stream state changed */ });
api.config();            // settings snapshot + discovered server endpoint
api.open("ses_…");       // open the chat view for a session
await api.server.health();
await api.server.messages("ses_…", { limit: 100, order: "asc" });
await api.server.prompt("ses_…", "fix the failing test");
await api.server.stop("ses_…");
```

Rows come pre-formatted: `titleLabel`, `stateLabel`
(`Running…`/`Idle`/`Needs approval`/`Interrupted`/`Error`/`Suspended`),
`updatedLabel`, `modelLabel`, `directoryLabel`, `tokensLabel`, plus raw DB fields.

## How state detection works

Primary: the plugin keeps one SSE connection to `GET /api/event` and maps
`session.execution.started` → running, `session.execution.succeeded` → idle,
`session.execution.interrupted` → interrupted, `session.execution.failed` →
error, `permission.asked` → needs approval. Fallback (server unreachable): a
session is Running when its latest assistant message in `session_message` has
no `time.completed` yet, or the newest message is still the user's — within a
15-minute freshness window; `time_suspended` reports Suspended only for
non-running sessions.

## Development

Plain single-file plugin, no build step (`main.js` is hand-written ES2022).
`node --check main.js` to syntax-check. Excluded from the repo: `data.json`
(local settings) and `.hotreload` (dev marker).
