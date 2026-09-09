# 004 — Session Tags

Status: implemented (v0.11.0)
Date: 2026-09-09
Depends on: spec/003-session-notes.md (notes index, frontmatter attachment)

## Goal

A session's tags are its note's tags — with full Obsidian semantics —
surfaced for filtering in dashboards, cards, and widgets. No separate tag
store: the vault is the source of truth.

## Design decisions

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Tag source | Frontmatter `tags:` **+ inline `#tags`** | Exactly what Obsidian's tag pane / `tag:` search see — "the way Obsidian works" is the UX contract. Both sources merge per tag (a tag can be both). |
| Normalization | Lowercase, `#` stripped, for matching; display keeps first-seen spelling | Obsidian treats tags case-insensitively; spelling drift should not split filters. |
| Index | Same metadataCache pass as the session id; `tagsBySession` map alongside `bySession` | Zero extra parsing cost; one cache read yields id + tags. |
| Change detection | Signature over (normalized, display, sources) per session | Tag edits refresh dashboards; tag-less body edits don't. Display-spelling changes count (they're visible on cards). |
| Editing | Notes panel chips row (`+` add, `×` remove) writing frontmatter `tags:` flow list | Properties-like UX. Inline-only tags render read-only (× hidden, tooltip explains) — removing them requires editing the body, mirroring Obsidian. Adding a tag to a noteless session creates the note first. |
| Query model | **The filter string is the single source of truth**: `#tag`, `is:<state>`, quoted phrases; popover and tag chips rewrite it | Transparent, backwards compatible with plain-text filtering, works headless (widgets parse the same grammar). |
| Widget option | `tags:` (list/comma) ANDs with `dirs:` | Intersection semantics consistent with existing dir filtering. |

## Filter grammar

```
query    := token*
token    := "#" value            → tag filter (case-insensitive)
          | "is:" value          → state: running|suspended|idle|waiting|question|interrupted|error
          | "dir:" value         → substring over raw + display directory
          | "model:" value       → substring over raw + display model
          | '"' phrase '"'       → substring over the session title
          | word                 → substring over the session title
```

All tokens AND. Values may be quoted for spaces (`model:"Sonnet 4.5"`);
bare prefixes while typing are ignored. `parseFilterQuery` /
`composeFilterQuery` round-trip (order preserved, values re-quoted when
needed). Free text matches the **title only** — every other axis has an
explicit prefix.

## Implementation map (main.js)

- `SessionNotes.tagsOf` — Obsidian-semantics extraction (frontmatter
  list/comma/scalar + inline cache tags); `tags(id)` accessor.
- `parseFilterQuery` / `composeFilterQuery` / `sanitizeTagName` /
  `parseFrontmatterTags` / `upsertFrontmatterTags` — module helpers, unit-tested.
- `SessionsDashboard` — `filterQuery` replaces `filterNeedle`;
  `filteredSessions` applies widget tags + query tags + states + phrases;
  funnel button + `renderFilterMenu` popover (Tags/State/Model/Directory with
  counts, active state mirrored from the query); `renderTagChips` on cards
  and table ID cells; `toggleFilter` rewrites the string.
- `SessionChatView` — `renderNoteTagsRow` / `beginAddNoteTag` /
  `applyNoteTags` (flush pending body edit → rewrite `tags:` → save);
  frontmatter of untouched keys preserved byte-for-byte.
- API — `vibed.notes.tags(id)` → `[{tag, frontmatter, inline}]`.

## Deliberate non-features

- **No tag autocomplete across the vault** in v1 (the panel input accepts
  free text; Obsidian's editor + tag pane already provide discovery).
- **No OR within a criterion** — AND only, like most filter bars; an OR
  needs explicit grouping syntax, deferred until asked for.
- **No tag management UI** (rename/merge across notes) — that's Obsidian's
  territory; vibed only reads and writes `tags:` like the properties editor.
