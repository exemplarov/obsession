# 003 — Session Notes

Status: implemented (v0.10.0)
Date: 2026-09-09
Depends on: spec/001-connector-architecture.md (connector model — notes are connector-agnostic)

## Goal

Attach a markdown note to any agent session, editable from the session chat
view. Notes are ordinary vault files — linkable, searchable, sync-friendly —
not data owned by the plugin.

## Design decisions

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Attachment key | `session: <sessionID>` frontmatter | Filename-independent: notes survive renames and moves anywhere in the vault. Ids (`ses_…`, UUIDs) are unique enough that the bare key is safe. |
| Lookup | Reverse index over `app.metadataCache` | Obsidian already parses all frontmatter in memory; one startup pass (`getFileCache` per md file, no disk I/O) + incremental `changed`/`delete` events. O(1) lookups. Same approach as Dataview. |
| Filename | `<session-id>-<sanitized-title>.md` | Human-browsable folder; cosmetic only — the index is authoritative, collisions get a numeric suffix. |
| Folder | `settings.notesDir`, default `vibed-notes` at vault root | Session working dirs may live outside the vault; the vault root always works. Empty setting restores the default. |
| Scope | All connectors | Notes live in the vault, not the backend — read-only connectors (Claude, Codex, Cursor) get them for free. |
| Creation | Lazy | The file appears only when *Create note* is clicked (or `ensureNote` is called); abandoned sessions leave no empty notes. |
| Editing | Inline side panel in the chat view | Toggle button in the chat header; textarea shows the body only, autosaves (600 ms debounce), original frontmatter block is preserved verbatim so user-added properties survive. *Open in editor* hands off to the real markdown editor. |

## Frontmatter written on creation

```yaml
---
session: ses_abc123
connector: opencode
title: "Session title"
created: 2026-09-09T12:00:00.000Z
---
```

Free-form values are JSON-quoted (valid YAML double-quoted scalars) so
`:`/`#` in names and titles cannot break parsing.

## Implementation map (main.js)

- `SessionNotes` — index (`bySession`, `sessionByFile` maps), `ensureNote`
  creation with collision suffixing; renames mutate `TFile` in place so the
  index needs no rename handler.
- Plugin `onload` — `metadataCache.on("changed"/"resolved")`, `vault.on("delete")`
  wiring; `refreshNoteBindings()` nudges open chat panels after each index
  rebuild (covers panels that rendered before the index was warm).
- `SessionChatView` — `renderNotes`/`loadNote`/`saveNoteNow` panel lifecycle:
  - state persisted in `getState()` (`notesOpen`) so workspace restore reopens it;
  - external edits sync in via `vault.on("modify")`, guarded to never clobber
    typing or a pending autosave (`noteSavePending` flag);
  - drafts hide the toggle until promotion (`updateNotesChrome` deferred-open).
- Settings — *Session notes folder* under General; `normalizeNotesDir` keeps it
  a clean vault-relative path.
- API — `globalThis.vibed.notes.find(id)` / `.folder()`.

## Deliberate non-features

- **No auto-rename on title drift** — the note keeps its creation-time
  filename; attachment is via frontmatter, so drift is cosmetic.
- **No re-attach when frontmatter is deleted** — a note whose `session:` key
  was removed reads as *not attached* (shown as *Create note*), never
  silently re-linked.
- **No per-widget notes config** — one folder for the plugin; dashboards
  don't render notes (the chat view owns the surface).
