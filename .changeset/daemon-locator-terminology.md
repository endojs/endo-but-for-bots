---
'@endo/daemon': patch
'@endo/cli': patch
---

Align the daemon's locator vocabulary with `designs/daemon-locator-terminology.md`.
`parseLocator` and `assertValidLocator` now report `Invalid peer key.`, `Missing formula address.`, and `Invalid formula address.` where they previously reported `Invalid node identifier.`, `Missing formula number.`, and `Invalid id.`.
The `locate` and `identify` help text and the `endo locate` description describe locators in terms of peer keys, formula addresses, formula keys, and connection hints.
No function signature or locator format changes.
