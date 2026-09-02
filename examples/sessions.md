---
tags:
  - opencode
  - plugin-test
---
# Eidolon sessions

OpenCode sessions for the eidolon workspaces (`/Users/roman/vaults/eidolon` + historical `/Users/roman/spaces/eidolon`). Rendered natively by the **OpenCode Sessions** plugin via an `opencode-sessions` code block — no Datacore involved. Click a title to copy its session ID; state badge shows **Running…** while a reply is streaming or a question is pending.

Supported block options: `dirs` (list, or omit for the plugin default), `basedir` (optional — relative `dirs` entries resolve against it and cards show directories relative to it), `layout: cards|table`, `pageSize` (defaults to the plugin's **Items per page** setting), `title`. The body can be simple `key: value` lines or JSON.

```opencode-sessions
layout: cards
basedir: /Users/roman/
dirs:
  - vaults/eidolon
  - spaces/eidolon
```
