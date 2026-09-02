# OpenCode Sessions (Obsidian plugin)

Browse your local [OpenCode](https://opencode.ai) AI-coding sessions directly in [Obsidian](https://obsidian.md) — as a dedicated view or as dashboards embedded in any note. Reads OpenCode's local SQLite database **read-only** via `sqlite3`; nothing leaves your machine.

![version](https://img.shields.io/badge/version-0.2.3-blue)

## Features

- **Note-embedded dashboards** via an `opencode-sessions` code block (cards or table layout) — no other plugins required.
- **Dedicated view** (command palette: *Open OpenCode sessions*, or the ribbon icon) with the same renderer.
- **Live session state**: `Running…` while a reply is streaming or a question is pending, `Suspended` for backgrounded sessions, otherwise `Idle`.
- Per-view **directories**, `basedir` shorthand, filtering, paging, and click-to-copy session IDs.
- **Push-based refresh**: one configurable timer in the plugin drives every open dashboard.
- Also exposes a small read-only API (`globalThis.opencodeSessions`) for e.g. Datacore JSX consumers.

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

See [examples/sessions.md](examples/sessions.md) for a real page.

## Settings

- **OpenCode database** — path to `opencode.db` (default: `~/.local/share/opencode/opencode.db`).
- **Storage backend** — `opencode2` (`session_v2`, OpenCode 2.x) or `opencode` (legacy `session` table).
- **sqlite3 executable** — usually `/usr/bin/sqlite3` (macOS).
- **Directories** — default directories for dashboards that omit `dirs`.
- **Custom SQL** — optional `WHERE` fragment (validated: no `;` or comments).
- **Refresh interval** — seconds between automatic refreshes (`0` disables).
- **Items per page** — default page size (10).

## Install (manual)

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/opencode-sessions/`, then enable **OpenCode Sessions**
under Settings → Community plugins. Desktop only (spawns `sqlite3`).

## API

`globalThis.opencodeSessions` (version 2):

```js
const api = globalThis.opencodeSessions;
const rows = await api.list({ dirs: ["/abs/path"], basedir: "/optional/prefix" });
const unsubscribe = api.subscribe(() => { /* data changed */ });
api.config(); // current settings snapshot
```

Rows come pre-formatted: `titleLabel`, `stateLabel` (`Running…`/`Suspended`/`Idle`),
`updatedLabel`, `modelLabel`, `directoryLabel`, `tokensLabel`, plus raw DB fields.

## How state detection works

A session is **Running** when its latest assistant message in `session_message`
has no `time.completed` yet (reply streaming), or when the newest message is
still the user's (question pending) — in both cases within a 15-minute
freshness window. `time_suspended` is only reported as **Suspended** when the
session is not running, since OpenCode also stamps it on sessions that keep
working in the background.

## Development

Plain single-file plugin, no build step (`main.js` is hand-written ES2022).
`node --check main.js` to syntax-check. Excluded from the repo: `data.json`
(local settings) and `.hotreload` (dev marker).
