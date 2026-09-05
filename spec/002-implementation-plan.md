# 002 — Connector Architecture: Implementation Plan

Status: proposed
Date: 2026-09-04
Depends on: spec/001-connector-architecture.md
Convention: single-file `main.js`, hand-written ES2022, no build step
(`node --check main.js` to syntax-check). Estimates assume that style.

## Phase overview

| Phase | Scope | Est. | Risk |
| ----- | ----- | ---- | ---- |
| 0 | Spec + branch/PR scaffolding | 0.5 d | – |
| 1 | Settings model, registry, OpenCode v2 driver extraction (behavior-identical refactor) | 2 d | medium (regressions) |
| 2 | OpenCode v2 API-only / remote modes + multi-instance streams | 1 d | low |
| 3 | File-based read-only connectors: claude-code, codex, cursor | 3 d | medium (parsers) |
| 4 | OpenCode v1 DB connector | 1 d | low |
| 5 | Polish: status UI, capability badges, README, API v4 docs | 1 d | low |

Phases 1–2 ship as **v0.8.0**, 3–4 as **v0.9.0**, 5 rolls into whichever
release is next. Each phase lands green: existing users' behavior must not
change until they add a second connector.

---

## Phase 0 — scaffolding

- [ ] Branch `connectors` off `main`.
- [ ] Create `spec/` (this doc + 001) committed to the repo.
- [ ] Baseline verification checklist (used again after every phase):
      dashboard view renders, code-block widget renders, chat streams live,
      prompt/stop works, approval banner appears, model selector populates,
      new-session flow works, `globalThis.opencodeSessions` functions.

## Phase 1 — registry + settings + v2 driver extraction (behavior-identical)

**Goal:** everything that exists today still works, now routed through the
registry with one implicit `opencode` connector.

### 1.1 Settings model (`OpenCodeSessionsPlugin.onload`)

- [ ] New defaults builder + migration per spec §4.2:
      `connectors[]`, `defaultConnectorId`, keep `pageSize`/`refreshSeconds`;
      drop legacy flat keys after first save.
- [ ] `generateConnectorName(kind)` — first free of `base`, `base-2`, …
      against existing names.
- [ ] `validateName(name)` — non-empty, no `:`, unique.

### 1.2 New code sections in `main.js`

Insert after `ServerEventStream` (data-layer band), before view classes:

- [ ] `CONNECTOR_KINDS` registry constant: `{ id, label, baseName, defaults }`
      for the five kinds (cursor/claude/codex/opencode1 entries arrive in
      their phases; declaring metadata early is fine).
- [ ] `ConnectorDriver` base class: constructor stores `{id, kind, name,
      config}`; `capabilities()` throws `not implemented`; no-op `dispose`.
- [ ] `OpenCode2Driver extends ConnectorDriver` — move logic, don't rewrite:
  - Owns an `OpenCodeClient` instance (client becomes per-driver; its
    `plugin.settings` reads become `connector.config` reads).
  - Owns a `ServerEventStream`-equivalent (stream gets a constructor arg for
    the client + a connector id tag on emitted events).
  - `listSessions()` = today's SQL (`loadSessions`) reading driver config
    (`databasePath`, `sqlitePath`, `directories`, `customSql`).
  - `getSession` / `listMessages` / `prompt` / `interrupt` / `models` /
    `defaultModel` / `setSessionModel` / `sessionPermissions` /
    `replyPermission` / `createSession` = thin wrappers on the client,
    mostly moving existing plugin methods.
  - `capabilities()` per spec §6 (opencode2 row).
  - Live-state map and `LIST_REFRESH_EVENTS` handling move from plugin to
    driver (keyed `connectorId:sessionId` at the plugin boundary).
- [ ] `ConnectorRegistry`: `rebuild()` (config-hash diffing), `get`,
      `byName`, `defaultConnector`, routed `listSessions`/`openSession`
      helpers with per-connector try/catch + `connector.status`.

### 1.3 Rewire the plugin body

- [ ] `plugin.registry` replaces direct `plugin.client` / `plugin.serverEvents`
      usage; `plugin.client` stays as a getter to the **default connector's**
      client (keeps settings tab + API v3 working with minimal edits).
- [ ] `handleServerEvent` routes by `event.connectorId` (tag added by the
      driver's stream) → `setLiveState(`${connectorId}:${sessionId}`, …)`.
- [ ] `SessionChatView`: constructor takes `ref {connectorId, sessionId}`;
      internal calls switch from `plugin.client.*` to `this.driver.*`;
      `plugin.subscribeSession(key)` uses the composite key.
      Draft state (`pendingDraftDirectory`) records the connector.
- [ ] `SessionsDashboard` + `SessionsDashboardChild` + `parseBlockConfig`:
      accept `connector: <name>`; resolve via `registry.byName`, default
      connector otherwise; error card for unknown names. Dashboard header
      shows the connector chip when non-default.
- [ ] `openSession(ref)` accepts pair or `"name:id"`; protocol handler
      gains `connector` param (legacy bare `sessionId` → default
      connector); `promptForSessionId` accepts both forms.
- [ ] Chat header: connector name chip next to session title.

### 1.4 Settings tab rewrite (structure, same fields as today)

- [ ] Global section: Default connector dropdown, Items per page, Refresh
      interval.
- [ ] Connector card for `opencode`: name (editable + validation), enabled
      toggle, status line (existing health text), delete/duplicate buttons,
      fields = today's server + SQLite fields, plus the **useDatabase**
      checkbox (Phase 2 makes it functional; ship visible-but-inert is not
      allowed — instead ship it functional in Phase 2 and hide until then).
- [ ] "Add connector" button with kind dropdown — only `opencode2` in this
      phase.

**Acceptance:** all Phase 0 checklist items pass with no settings changes
(auto-migration covered by a `data.json` fixture test); second `opencode2`
connector can be added and listed from the same DB (proves multi-instance
plumbing); deleting/renaming connectors behaves per spec §4.4.

## Phase 2 — OpenCode v2 API-only and remote modes

- [ ] `useDatabase: false` (or missing/unreadable DB) → `listSessions` via
      `GET /api/session`, filter client-side by `location.directory` against
      configured dirs; map API session objects to the decorated row shape
      (`time.updated → time_updated`, `tokens.*`, `cost`, `model.id`
      stringification via `modelLabel`). State via live stream only
      (no DB heuristic fallback; label from `/api/session/active` +
      `time.idle`).
- [ ] Settings UI: reveal the `useDatabase` checkbox; toggling hides/shows
      DB fields; custom SQL hidden in API mode; help text for remote URL
      (`http://host:49374` + password override note).
- [ ] Multi-stream: second `opencode2` connector connects its own SSE;
      verify event routing keys don't collide (composite keys from 1.3).
- [ ] Remote caveat in status line: show discovered vs overridden URL.

**Acceptance:** local server stopped + DB present → widgets still render via
API with live states (proves API path); connector pointed at a second
opencode instance lists its sessions and streams events independently.

## Phase 3 — file-based read-only connectors

Shared infrastructure first, then one driver each. All three convert into
the normalized message model (spec §7.2) and share:

- [ ] ~~`DirWatcher`: recursive `fs.watch`~~ **Implemented differently**: file
      backends refresh via existing plugin machinery — dashboards re-list on
      the global refresh interval, open chats poll `reconcileNow()` every 3 s
      against an mtime/size-bounded parse cache (in-flight memoized, LRU 6,
      128 MB parse cap, 200 KB per-tool-output cap). Capability reports
      `live: "poll"`. An fs.watch-based DirWatcher can replace the poller
      later without interface changes.
- [ ] `FileConnectorDriver extends ConnectorDriver`: common
  - `listSessions`: enumerate root, parse headers lazily (session row needs
    only head+tail of each file: first user line, last timestamp line —
    implement `scanSessionFile(path, {headerOnly})` per format to keep
    listing fast across hundreds of files; fall back to full parse when
    cheap).
  - In-memory pagination: parse whole file, slice newest-first pages,
    return synthetic cursors (`offset:n`), reverse for render order.
  - Message ids stable per format (`uuid` line field for claude;
    `file:line` for codex/cursor).
  - Directory decode helper `matchEncodedDir(encoded, configuredDirs)`:
    slugify each configured dir and compare (edge hyphens trimmed — Claude
    keeps the leading dash, Cursor drops it); fallback label = encoded string.
  - `capabilities()`: `chat: false, models: false, permissions: false,
    drafts: false, live: "fs-watch"`, `titles`/`tokens` per format.
- [ ] Chat view degradation: composer → "Read-only connector" notice when
      `!capabilities.chat`; "Load older" works against synthetic cursors;
      `formatTime`/`formatDate` null-guards (cursor messages have no time);
      header badge shows "watching" instead of live SSE states.

Per-format work:

- [ ] `ClaudeCodeDriver`: path `~/.claude/projects/<slug>/*.jsonl`;
      converters per spec §7.2 (thinking→reasoning, tool_use/tool_result
      pairing, `ai-title` titles, usage sums, sidechain skip, unknown line
      types skipped).
- [ ] `CodexDriver`: `~/.codex/sessions/**/rollout-*.jsonl` walk;
      envelope dispatch per spec §7.2; developer messages → collapsed system
      notes; `.zst` via configured `zstd -dc` (warning + skip when absent);
      title from first user `input_item` (80 chars).
- [ ] `CursorDriver`: `~/.cursor/projects/*/agent-transcripts/<uuid>/*.jsonl`;
      Claude-API block conversion; `turn_ended` finalizes open tool parts
      (tool results are never recorded in transcripts); derived title from
      first user text (`<user_query>` unwrapped); `tokens: false`,
      `titles: "derived"`; CLI-chat metadata listing behind an option
      (default off, spec §11.2) — **deferred**, revisit with Phase 5.
- [ ] Settings cards per kind (path fields + directories), Add-connector
      dropdown now offers `claude-code`, `codex`, `cursor`.

**Acceptance:** each driver lists real local data (this machine: 5 Claude
projects, 137 Codex rollouts, multiple Cursor transcripts); chat opens with
tool calls, reasoning, and outputs rendered; appending to a transcript file
live-updates an open chat; a corrupt file produces a warning, not a crash;
deleting the file mid-watch doesn't crash the watcher.

## Phase 4 — OpenCode v1 connector

- [ ] `OpenCode1Driver`: same sqlite3 plumbing; `session` table listing
      (columns per spec §10.2), `message`+`part` merge into normalized
      messages (parts ordered by `part.id`; validate against the 58k local
      v1 messages — spot-check tool parts, agent fields, time shapes).
- [ ] State: idle/historical; no live stream; title from `session.title`.
- [ ] Settings card: DB path, sqlite3 path, directories (note: v1 and v2
      commonly share `opencode.db`; both connectors may point at it).

**Acceptance:** v1 sessions (1,811 locally) list and open; messages with
tool parts render; v2 connector on the same DB file unaffected.

## Phase 5 — polish & release

- [ ] Per-connector status surfaced on dashboards (error banner text from
      `connector.status.lastError`).
- [ ] Capability badges in settings cards ("read-only", "live").
- [ ] `globalThis.opencodeSessions` v4 (spec §8) with per-connector
      namespaces; keep v3 default-connector behavior.
- [ ] README rewrite: connector model, settings, per-backend caveats table
      (timestamps/titles/tokens support), link/protocol `connector` param.
- [ ] Manifest bump + version tags per release batch.
- [ ] Manual test matrix: each kind × {dashboard view, widget block, chat,
      live update, settings edit/rename/delete, default switch}.

## Testing strategy (no framework in-repo today)

- `node --check main.js` after every edit (existing convention).
- Node-runnable pure-function smoke checks during development (converters,
  name suggester, migrations) executed ad hoc with `node -e` against fixture
  JSONL lines captured from real transcripts (keep fixtures under
  `examples/fixtures/`, committed).
- Manual matrix above per release; real local corpora for every backend
  already exist on the dev machine.

## Sequencing notes / risks

- Phase 1 is the risk-heavy refactor; it intentionally ships zero new
  features so regressions bisect cleanly.
- Codex format is undocumented and evolves (v0.134+ added SQLite index;
  `.zst` compression) — parser must skip unknown envelope types and the
  connector must degrade to "listing only" if message parsing fails.
- Claude/Cursor slug decoding is lossy; the configured-dirs matching is a
  heuristic — surfaced as a docs caveat, not silently wrong paths.
- Keep `source` on decorated rows (backend kind) for Datacore/JSX consumers;
  the v0.7 `databaseKind` *setting* is gone — v1 is its own connector kind.
