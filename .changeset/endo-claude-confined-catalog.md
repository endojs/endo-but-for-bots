---
'@endo/claude': minor
---

`runConfinedTurn` now offers the confined `claude` a narrower tool surface.
`@endo/agent-mcp-stdio`'s `startGuestBroker` serves only its confined allow-list, so `evaluate`, `define`, the identifier and formula-locator tools, and `loadContent` are absent from the turn's `tools/list` and refused if called by name.
