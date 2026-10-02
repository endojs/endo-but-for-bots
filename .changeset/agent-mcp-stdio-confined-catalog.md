---
'@endo/agent-mcp-stdio': minor
---

`startGuestBroker` serves only the confined allow-list (`confinedToolNames`) by default, not the full guest catalog.
Withheld names (`evaluate`, `define`, and the identifier and formula-locator tools) are absent from the broker's `tools/list` and refused at `tools/call`.
An `allowedToolNames` option replaces the default allow-list; it is not intersected with it.
The allow-list and `selectConfinedTools` are exported.
