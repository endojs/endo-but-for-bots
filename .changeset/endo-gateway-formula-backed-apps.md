---
'@endo/gateway': minor
---

`@endo/gateway` Feature 2: formula-backed `AppsNameHub`. When a host
supplies an `appsFormulaStore` power to `makeGateway`, the gateway's
`AppsNameHub` persists bindings through the store and hydrates the
in-memory view from the store at construction time. Calls to `bind`
and `unbind` write through; if the store throws, the in-memory map
rolls back so the two stay in sync. `Gateway.start()` awaits the
initial hydration and surfaces any hydration failure as a startup
error rather than degrading silently to in-memory.

The `AppsFormulaStore` shape (`listBindings`, `writeBinding`,
`deleteBinding`) is the embedder's contract for adapting the
daemon-side persistence. When no store is supplied the gateway
keeps the in-memory phase-1 behavior unchanged.

The `WebletFormula` typedef (`type: 'weblet'`, `contentRoot`,
optional `mimeTypes`, `ssrHandler`, `virtualHosts`) ships alongside
as the daemon-side formula shape the bindings reference; the
gateway exports a `validateWebletFormula` helper that an adapter
can use to gate inputs from the store.
