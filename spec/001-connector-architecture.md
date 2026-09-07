# 001 — Connector Architecture (Multi-Backend Sessions)

Status: proposed
Date: 2026-09-04
Applies to: Obsession (formerly opencode-sessions) ≥ 0.8.0

## 1. Goal

Turn the plugin from a single-backend viewer (local OpenCode v2) into a
multi-backend session browser built around an abstract **connector** layer:

- **OpenCode v2 stays first-class.** The plugin's purpose remains leveraging
  OpenCode v2 capabilities (live SSE streaming, prompting, interruptions,
  approvals, models, drafts). Everything else is a nice-to-have, read-mostly
  companion.
- **Named, multiple connectors.** Several connectors of the same kind may
  coexist (e.g. two remote OpenCode v2 servers, three Codex installs).
- **Zero-config default.** The existing local OpenCode v2 (DB + API) connector
  is created implicitly and works with no settings changes, exactly like
  v0.7.0.
- **Graceful degradation.** Connectors declare capabilities; the UI hides what
  a connector cannot do. A failing connector must never break the plugin or
  other connectors.

## 2. Non-goals (v1 of this architecture)

- No cross-connector aggregation in one dashboard (`connector: all` may come
  later; see Open Questions).
- No write support for file-based backends (prompting the Claude/Codex/Cursor
  CLIs from Obsidian).
- No decoding of Cursor's CLI `store.db` protobuf blob chain (IDE agent
  transcripts only; see §10.5).
- No unified full-text search across backends.
- No change to the single-file, no-build plugin convention (`main.js`,
  hand-written ES2022). The connector layer is added as clearly banded
  sections inside `main.js`; splitting into modules can be revisited if the
  file becomes unwieldy.

## 3. Connector kinds

| kind id          | backend                        | transport            | default name |
| ---------------- | ------------------------------ | -------------------- | ------------ |
| `opencode2`      | OpenCode v2 server + SQLite DB | HTTP API + SSE + sqlite3 | `opencode` |
| `opencode1`      | OpenCode v1 SQLite DB          | sqlite3              | `opencode-v1` |
| `claude-code`    | Claude Code JSONL transcripts  | files + fs.watch     | `claude` |
| `codex`          | Codex CLI rollout JSONL        | files + fs.watch     | `codex` |
| `cursor`         | Cursor IDE agent transcripts   | files + fs.watch     | `cursor` |

All kinds except `opencode2` are local-only and read-only in v1.

### 3.1 `opencode2` operating modes

One kind, three modes derived from config:

| mode            | `useDatabase` | `apiBaseUrl` | listing source | notes |
| --------------- | ------------- | ------------ | -------------- | ----- |
| **local hybrid** (default, zero-config) | ✔ | empty (auto-discover) | SQLite `session_v2` | current v0.7 behavior; DB listing + API live/chat |
| **API-only**    | ✖ | any (may be empty → local server, list via API) | `GET /api/session` | for setups without local DB access; also used when the DB file is missing/unreadable |
| **remote**      | optional | set (e.g. `http://box:49374`) | `GET /api/session` (or remote DB path if both given) | remote server instance; password required by the server's basic auth |

`useDatabase` is a checkbox in connector settings. When enabled, the SQLite
path fields appear (DB path, sqlite3 executable, custom SQL, directories).
When disabled, custom SQL is not applicable (API listing is filtered
client-side by directory instead).

## 4. Settings model

### 4.1 Persisted shape (`data.json`)

```jsonc
{
  "schemaVersion": 2,
  "defaultConnectorId": "c-8f2a…",          // which connector widgets/chats use by default
  "pageSize": 10,                             // global (unchanged)
  "refreshSeconds": 30,                       // global (unchanged)
  "connectors": [
    {
      "id": "c-8f2a…",                        // stable internal id (uuid)
      "kind": "opencode2",
      "name": "opencode",                     // unique, user-editable
      "enabled": true,
      "config": {                              // kind-specific
        "apiBaseUrl": "",
        "apiPassword": "",
        "useDatabase": true,
        "databasePath": "~/.local/share/opencode/opencode.db",
        "sqlitePath": "sqlite3",
        "directories": ["~/vaults/myvault"],
        "customSql": ""
      }
    }
  ]
}
```

Kind-specific `config` defaults:

- `opencode2`: current v0.7 defaults (auto-discover URL, default DB path,
  `sqlite3`, `useDatabase: true`, `directories: [vaultRoot]`).
- `opencode1`: `databasePath` (default `~/.local/share/opencode/opencode.db`
  — v1 data lives in the same DB file on machines that ran v1), `sqlitePath`,
  `directories`.
- `claude-code`: `projectsRoot` (default `~/.claude/projects`), `directories`.
- `codex`: `sessionsRoot` (default `~/.codex/sessions`), `zstdPath`
  (default `zstd` — only used for `.zst` rollouts), `directories`.
- `cursor`: `projectsRoot` (default `~/.cursor/projects`), `directories`.

### 4.2 Migration (v0.7 → schemaVersion 2)

On load, if `saved.connectors` is absent:

1. Build one `opencode2` connector from the flat keys: `apiBaseUrl`,
   `apiPassword`, `databasePath`, `sqlitePath`, `directories`, `customSql`
   → `config`; `useDatabase: true`; name `opencode`.
2. `defaultConnectorId` = that connector's id.
3. `pageSize`, `refreshSeconds` carry over; legacy flat keys are dropped after
   the first `saveData`.
4. Existing `data.json` consumers (`globalThis.obsession.config()`)
   keep working — see §8.

Migration is transparent: a user upgrading sees identical behavior.

### 4.3 Naming

- Suggested name when adding a connector = first free value of
  `base`, `base-2`, `base-3`, … where `base` is the kind's default name
  (`opencode`, `opencode-v1`, `claude`, `codex`, `cursor`).
  Example: second OpenCode v2 connector → `opencode-2`; a second Codex →
  `codex-2`; a v1 connector → `opencode-v1`.
- Names are editable and must be unique, non-empty, and must not contain `:`
  (reserved for the session-ref syntax below).
- Renames take effect everywhere (widgets reference connectors by name).

### 4.4 Settings UI

- **Global section**: *Default connector* (dropdown of connector names),
  *Items per page*, *Refresh interval*.
- **Connectors section**: one collapsible card per connector:
  - Header: kind icon, name (inline-editable), enabled toggle, status dot
    (health probe result + last error), delete button, duplicate button.
  - Body: kind-specific fields (see §4.1). `opencode2` shows mode-dependent
    fields (`useDatabase` checkbox toggles DB fields; URL field labeled
    "Server URL — empty = auto-discover local server").
- **Add connector** button: kind dropdown → creates connector with suggested
  name, enabled, expanded for editing.
- Deleting the default connector falls back to the first remaining connector.
  Disabling it behaves the same at runtime (default resolves to the first
  *enabled* connector; if none, widgets render "No connector configured").

## 5. Runtime architecture

### 5.1 ConnectorRegistry (new, plugin-owned)

```
plugin.registry
  ├─ connectors: Map<id, Connector>         // Connector = { config, driver, status }
  ├─ byName(name) → Connector
  ├─ get(idOrName) → Connector
  ├─ defaultConnector() → Connector|null    // defaultConnectorId → first enabled
  ├─ listSessions(query) / …                // routed calls, error-isolated (§5.4)
  └─ status listeners (settings UI, dashboards)
```

- **Note (implementation deviation, accepted):** there is no `rebuild()`
  with config-hash diffing — settings edits mutate the shared
  connector/config objects that drivers hold references to, so field edits
  apply live without recreating drivers (no SSE reconnect churn while
  typing). Only add/delete and enable/disable touch the registry. Connection
  fields (URL/password) restart their driver explicitly.
- Per-connector status recording (`status.lastError`) is deferred; views
  catch and surface their own errors per dashboard/chat today.
- Registry owns per-connector lifecycles: OpenCode v2 connectors each get
  their own `OpenCodeClient` + `ServerEventStream`; file connectors get a
  shared `DirWatcher` (fs.watch with recursive flag where available, polling
  fallback, debounced 300 ms).

### 5.2 Driver interface

Every backend implements this interface (single-file: base class
`ConnectorDriver` in main.js):

```js
class ConnectorDriver {
  constructor(connector, plugin)          // connector = { id, kind, name, config }
  capabilities()                          // → descriptor, §6
  async health()                          // → { ok, detail } for settings/status UI
  async listSessions(query)               // { dirs?, basedir? } → decorated rows[]
  async getSession(sessionId)             // → normalized session or null
  async listMessages(sessionId, opts)     // { limit, order, cursor } → { data, cursor }
  watchList(cb) / watchSession(id, cb)    // → unwatch fn (SSE or fs events)
  dispose()
  // Optional, capability-gated:
  async prompt(id, text) / async interrupt(id)
  async models(dir) / defaultModel(dir) / setSessionModel(id, model)
  async createSession({ directory, model, text })
  sessionPermissions(id) / replyPermission(id, requestId, reply)
}
```

Contract rules:

- Methods may throw; callers (registry/views) must catch. A thrown error is
  scoped to the connector that produced it.
- `listSessions` returns rows already passed through the existing
  `decorateRow` shape, plus `connectorId`, `connectorName`, `source` (kind),
  and `readOnly` flags — views need no per-backend branching.
- `listMessages` returns messages in the **normalized message model** (§7).
  File-based drivers emulate cursor pagination by slicing the parsed array
  in memory (files are small; OpenCode DB/API pagination stays real).

### 5.3 Session references

All session-identifying state becomes a pair `{ connectorId, sessionId }`.
At the UI boundary (links, widget params, protocol handler) the pair is
expressed as `name:sessionId` (e.g. `claude:4108410a-7f35-…`). Names are
unique and `:`-free, making this unambiguous and human-readable.

- Widget: `connector: claude` (by name) + ids stay plain.
- Links: `obsidian://obsession?connector=claude&sessionId=<id>`; the
  legacy `?sessionId=` form resolves against the default connector.
- `plugin.openSession(ref)` accepts either the pair or a `"name:id"` string.

### 5.4 Error isolation

- Registry wraps every driver call: failures are caught, recorded on
  `connector.status.lastError` (with timestamp), and returned as empty
  results or rethrown to the specific view — never propagated across
  connectors.
- Dashboards/chats render a per-connector banner ("connector opencode-2:
  server unreachable — showing nothing / read-only data unavailable").
- A connector that throws in `health()` or repeatedly in `watchList` gets
  its status dot turned red in settings; other connectors are unaffected.
- File-based drivers tolerate per-file parse errors: unreadable/corrupt
  files are skipped and counted (`status.warnings`), never fatal.

## 6. Capability model

```js
capabilities = {
  listing:   "db" | "api" | "files",
  live:      "sse" | "fs-watch" | "none",
  messages:  true,          // can render a chat view
  pagination true | false,  // real cursor pagination vs in-memory slices
  chat:      false,         // prompt + interrupt
  models:    false,         // model selector
  permissions: false,       // approval banner
  drafts:    false,         // "New session" flow
  tokens:    true,          // token usage labels
  cost:      false,
  titles:    "stored" | "derived" | "none",
  rename:    false,
}
```

Matrix:

| capability | opencode2 | opencode1 | claude-code | codex | cursor |
| ---------- | ----------| ---------- | ----------- | ----- | ------ |
| listing | db / api | db | files | files | files |
| live | sse | none | fs-watch | fs-watch | fs-watch |
| messages | ✔ | ✔ | ✔ | ✔ | ✔ |
| pagination | ✔ (cursor) | ✔ (in-memory) | ✔ (in-memory) | ✔ (in-memory) | ✔ (in-memory) |
| chat | ✔ | ✖ | ✖ | ✖ | ✖ |
| models | ✔ | ✖ | ✖ | ✖ | ✖ |
| permissions | ✔ | ✖ | ✖ | ✖ | ✖ |
| drafts | ✔ | ✖ | ✖ | ✖ | ✖ |
| tokens | ✔ | ✔ | ✔ (summed usage) | ✔ (token_count events) | ✖ |
| cost | ✔ | ✔ | ✖ | ✖ | ✖ |
| titles | stored | stored | stored (`ai-title`) | derived | derived |
| rename | ✖ (v2 API has no rename yet) | ✖ | ✖ | ✖ | ✖ |

UI degradation rules (implemented once, driven by the descriptor):

- No `chat` → composer replaced by a "Read-only" notice; `Stop` button hidden.
- No `models` → model selector hidden (no error path like today's
  `loadModels` catch).
- No `permissions` → approval banner code paths disabled.
- No `drafts` → "New session" command scoped to connectors that support it;
  dashboard *New session* button uses the default connector only if capable,
  otherwise hidden.
- No `live` → state labels come from static/derived state only; header shows
  no live dot.
- No `tokens`/`cost` → cells render empty instead of `0`.
- `titles: "none"` (not currently produced) → falls back to "Untitled".
- `fs-watch` connectors: "running" is a heuristic (file mtime/last-event
  freshness < N seconds); label reads "Active (watching)" rather than
  pretending SSE certainty.

## 7. Normalized data model

The internal model stays **exactly the OpenCode v2 shape** (it is the
richest and already drives every view). Backends convert into it.

### 7.1 Session row (decorated)

Today's fields (`id, directory, title, model, agent, time_created,
time_updated, cost, tokens_*, time_suspended, version`) plus
`connectorId, connectorName, source, readOnly`. `decorateRow` remains the
single decoration point (it becomes a free function; the SQL specifics stay
in the opencode drivers).

### 7.2 Message

```js
{ id, type: "user"|"assistant"|"system", time: { created?, streamed?, completed? },
  text?, agent?, model?, error?, finish?,
  content: [                               // assistant parts
    { type: "text", text },
    { type: "reasoning", text },
    { type: "tool", id, name, state: { status, input, content[], error? } }
  ],
  files?, agents?, skills? }
```

Converter notes per backend (verified against real data on 2026-09-04;
appendix §10 has the raw formats):

- **claude-code**: line `type: "user"` → user message (`text` = string
  content or joined text blocks; `tool_result` blocks attach to the matching
  `tool_use` part by `tool_use_id`, setting `state.status` + output).
  `assistant` lines → content blocks `thinking → reasoning`, `text → text`,
  `tool_use → tool` (input as-is; status pending until its result line
  appears). `ai-title` lines feed the session title; `usage` sums to tokens.
  `isSidechain: true` lines (subagent transcripts) are skipped in v1.
  Non-message lines (`mode`, `permission-mode`, `last-prompt`,
  `file-history-snapshot`, `attachment`) are skipped.
  Message ids = the line `uuid` field (stable across re-parses → live
  upserts work).
- **codex**: envelope `{timestamp, type, payload}`. `session_meta.cwd` →
  directory; title = first user `input_item` text truncated to 80 chars;
  model from the latest `turn_context`; tokens summed from
  `event_msg.token_count.info.total_token_usage`.
  `response_item.payload.type`: `message` (role `developer` → collapsed
  system note; `user` → user message; `assistant` → assistant with
  `output_text` blocks), `function_call` → tool part (input = arguments
  string), `function_call_output` → attach output by `call_id`,
  `reasoning` → reasoning part (summary text preferred).
  Line order is stable (append-only) → message ids = `file:line` are stable.
  `.zst` rollouts are decompressed via the configured `zstd -dc` when
  available, skipped (with warning) otherwise.
- **cursor** (IDE transcripts `agent-transcripts/<uuid>/<uuid>.jsonl`): lines
  `{role, message: {content: [...]}}` with Claude-API-style blocks
  (`text`, `tool_use {name, input}`, `tool_result {content}`); `turn_ended`
  lines finalize open tool parts. No per-line ids/timestamps → ids =
  `file:line`, `time.created = null` (the chat renderer must tolerate null
  times; `formatTime` gains a null guard). Session directory is decoded from
  the parent `projects/<encoded>` folder name — encoding is lossy
  (non-alphanumerics → `-`), so decode by matching against configured
  directories (slugify each configured dir, compare) and fall back to the
  raw encoded label.
- **claude-code** directory decoding has the same lossy-slug problem and the
  same configured-dirs disambiguation (`~/.claude/projects/<slug>/`).
- **opencode1**: `session` table columns map 1:1 (no `time_suspended`,
  `fork_*`). Messages: `message.data` JSON is already the v2 message
  envelope shape; its `content` parts live in the `part` table (`part.data`
  JSON, ordered by `part.id`) and are merged back onto the message.
  Verified locally: 1,811 v1 sessions / 58,848 messages available as test
  data. Listing/state heuristics reuse the existing SQLite fallback logic;
  sessions are treated as historical (idle) unless the last assistant
  message is incomplete within the freshness window.

## 8. Public API (`globalThis.obsession`)

Version 4, additive; v3 shapes keep working when only the default connector
is involved:

```js
api.connectors()                    // [{ id, name, kind, enabled, capabilities }]
api.connector(name)                 // namespace bound to one connector
  .list(query) .messages(id, opts) .prompt(id, text) .stop(id) .health()
api.list(query)                     // default connector (v3 behavior)
api.subscribe(fn)                   // fires for any connector change
api.open("claude:4108410a-…")       // accepts "name:id"
api.config()                        // v3 fields + { connectors: [...], defaultConnector }
```

## 9. Widget & chat changes

- `parseBlockConfig` gains `connector: <name>` (both simple and JSON forms).
  Unknown name → block renders an inline error card. Omitted → default
  connector.
- Dashboard header shows the connector name chip (when not the implicit
  default) and per-connector error banner.
- `SessionChatView` binds to `{ connectorId, sessionId }`; everything
  API-facing goes through `driver` instead of `plugin.client` directly.
  Offline fallback for opencode2 stays; read-only connectors never show a
  composer at all.
- `promptForSessionId` asks for a `name:id` or bare id (bare → default).
- `NewSessionView` is scoped to the default connector (or a connector
  argument on the command).

## 10. Appendix — researched backend formats (2026-09-04, local verification)

### 10.1 OpenCode v2 (local)

- DB: `~/.local/share/opencode/opencode.db` — `session_v2`, `session_message`
  (message envelope JSON in `data`), plus `project`, `workspace`, etc.
- Server discovery: `~/.local/state/opencode/service.json`
  (`{url, password, pid, version}`), config fallback
  `~/.config/opencode/opencode.json`, ports 49374 / 4096.
- API (beta, basic auth `opencode:<password>`): `GET /api/health`,
  `GET /api/session` (**full list**; each item has `id, title, agent, model,
  cost, tokens, time{created,updated,…}, location.directory`),
  `GET /api/session/active`, `GET /api/session/:id`,
  `GET /api/session/:id/message?limit&order&cursor` (`{data, cursor.next}`),
  `POST /api/session/:id/prompt|interrupt|model`,
  `GET/POST /api/session/:id/permission[/:requestId/reply]`,
  `GET /api/model[/default]?location[directory]=…`, SSE `GET /api/event`.

### 10.2 OpenCode v1 (local, same DB file)

- `session` (≈ `session_v2` minus fork/suspend columns), `message`
  (`session_id`, `data` JSON = message envelope), `part` (`message_id`,
  `data` JSON = part). All read via the same spawned `sqlite3`.

### 10.3 Claude Code (local files)

- `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`; slug = cwd with
  non-alphanumerics → `-` (lossy).
- Line types observed: `user`, `assistant` (content blocks `text`,
  `thinking` with signature, `tool_use`; `usage`, per-line `timestamp`,
  `model`), `attachment`, `summary`, `ai-title` (repeated; latest wins),
  `mode`, `permission-mode`, `last-prompt`, `file-history-snapshot`,
  `system`. Lines carry `uuid`, `parentUuid`, `isSidechain`.
- `tool_result` blocks arrive in subsequent `user`-typed lines.

### 10.4 Codex CLI (local files)

- `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (possibly
  `.zst`-compressed for cold sessions; `zstd` at `/opt/homebrew/bin/zstd`
  locally).
- Envelope `{timestamp, type, payload}`; types: `session_meta` (cwd, model
  provider, cli version, base instructions), `turn_context` (active model),
  `response_item` (`message` with `input_text`/`output_text`,
  `function_call`/`function_call_output` paired by `call_id`, `reasoning`),
  `event_msg` (`task_started`, `token_count`, `agent_message`, …),
  `input_item` (user prompts), `config_snapshot`.
- Format is undocumented; treat parsing as best-effort with forward
  compatibility (skip unknown `type`s).

### 10.5 Cursor (local files + SQLite)

- IDE/agent transcripts: `~/.cursor/projects/<encoded-cwd>/agent-transcripts/
  <uuid>/<uuid>.jsonl` — clean JSONL, Claude-API-style content blocks
  (`text`, `tool_use{name,input}`, `tool_result`), plus
  `{type:"turn_ended", status}` markers. **No per-message timestamps, no
  titles, no model/tokens.** Primary target for the `cursor` connector.
  Encoded cwd differs from Claude's: Claude keeps the leading dash
  (`-Users-roman-…`) while Cursor drops it (`Users-roman-…`); slug
  comparisons trim edge hyphens so one slug table matches both.
- CLI chats: `~/.cursor/chats/<project-hash>/<session-uuid>/` containing
  `meta.json` (`{title, cwd, createdAtMs, updatedAtMs}` — clean and useful)
  and `store.db` (SQLite: `blobs(id, data)`, `meta`). The conversation body
  is a **protobuf-framed, content-addressed blob chain** (`latestRootBlobId`
  in `meta`; nodes reference 32-byte child hashes). Decoding is brittle and
  undocumented → **out of scope v1**; optionally surface CLI sessions from
  `meta.json` as title-only rows with a "transcript unavailable" state.
- IDE chat history outside `agent-transcripts` (workspace `state.vscdb`)
  stays out of scope.

## 11. Open questions

1. **`connector: all` aggregation** — merge rows from every enabled
   connector in one dashboard (sorted by `time_updated`)? Cheap to add
   later via registry; deferred.
2. **Cursor CLI sessions via `meta.json`** — include title/cwd-only rows
   (no messages) or omit CLI chats entirely until protobuf decoding exists?
   Proposal: include behind a connector option "List CLI chats (metadata
   only)", default off.
3. **Claude Code live "running" detection** — file-size growth heuristic vs
   always-idle. Proposal: freshness heuristic with 15-min window (mirrors
   the existing SQLite fallback).
4. **Per-connector refresh intervals** — global `refreshSeconds` applies to
   polling; fs-watch connectors don't need it. Keep global for v1.
5. **v2 session rename/delete** — not in the current beta API; the
   capability flags exist so drivers can advertise them later.
