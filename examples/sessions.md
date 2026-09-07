---
tags:
  - opencode
  - plugin-test
---
# Agent sessions dashboard

A dashboard of agent sessions for a couple of workspaces (a current vault plus
a historical checkout). Rendered natively by the **Obsession** plugin via an
`obsession` code block — no Datacore involved. Click a title to copy
its session ID; state badge shows **Running…** while a reply is streaming or a
question is pending.

Supported block options: `dirs` (list, or omit for the plugin default),
`basedir` (optional — relative `dirs` entries resolve against it and cards
show directories relative to it), `layout: cards|table`, `pageSize` (defaults
to the plugin's **Items per page** setting), `title`. The body can be simple
`key: value` lines or JSON.

```obsession
layout: cards
basedir: ~/
dirs:
  - vaults/my-project
  - spaces/my-project
```
