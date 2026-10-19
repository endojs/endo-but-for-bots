---
'@endo/daemon': patch
'@endo/cli': patch
---

`parseLocator` and `assertValidLocator` now report `Invalid peer key.`, `Missing formula address.`, and `Invalid formula address.` where they previously reported `Invalid node identifier.`, `Missing formula number.`, and `Invalid id.`.
Code that matches on the old message text must be updated.
The `locate` and `identify` help text and the `endo locate` description now describe locators in terms of peer keys, formula addresses, formula keys, and connection hints.
