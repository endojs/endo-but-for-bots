# Design Questions

### familiar-unified-weblet-server.md — 2026-04-17

**Question:** The previous status section claimed the unified weblet server was fully implemented in `packages/daemon/src/web-server-node.js`, but this file does not exist on `origin/llm`. Was this work done on a different branch, reverted, or written prospectively?

**Context:** The Familiar-side `localhttp://` protocol handler exists (`packages/familiar/src/protocol-handler.js`), but the daemon-side unified web server — including `webletHandlers`, `makeWeblet`, virtual host routing, and per-weblet CapTP — does not exist. The design status has been corrected to "Partially implemented" to reflect what is actually present.

**Assumption:** The previous status was written prospectively or describes work on a branch not merged to `origin/llm`. Proceeding with the corrected status that only Familiar-side infrastructure is implemented.

**Status:** Open
