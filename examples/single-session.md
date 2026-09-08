---
tags:
  - opencode
  - plugin-test
---
# Pinned session

A single session pinned into a note: with only the `sessions` option the
block renders a clean widget — just the card, no toolbar or filter. Handy for
a project status note that tracks one long-running agent session.

Swap in a real session id (right-click a dashboard card → copy, or use the
*Copy ID* button in a chat). A missing id renders as a dashed "(not found)"
card instead of an error.

```vibed
sessions:
  - ses_abc123def456
```

Ids resolve against the block's connector — the one named by `connector:`,
or the default connector otherwise. To pin a session from another backend,
name it (e.g. `connector: claude`) and use its raw session id.
