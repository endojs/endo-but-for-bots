---
'@endo/spaces-util': minor
'@endo/space-chat': minor
'@endo/space-channel': minor
'@endo/chat': minor
---

Add the read-only retention-paths Chat UI panel (design `daemon-retention-paths.md` Phase 4).

Every value chip in the inbox, inventory, transcript (channel / forum / microblog), and value modal grows a small chain-link "paths" reveal affordance.
Clicking it opens a floating, read-only Paths panel that subscribes to the host's `followRetentionPaths(locator)` API (the host facet only, never a guest) and renders every retaining path in the CLI's notation: pet-name edges as a bold-name chip with the parent store label, internal field edges as a small grey `→<field>` arrow, cross-peer `retention` and `transient` edges as tags, with the leaf (target value) highlighted and the empty / unretained state handled.
The panel folds the microtask-coalesced `{ snapshot }` then `{ added, removed }` deltas in place; closing it drops the far reference so the producer generator returns and the subscription is released.

The new `@endo/spaces-util` modules (`retention-paths.js` view + delta engine, `retention-paths-panel.js` host wrapper) hold the only host authority; the confined value chips carry just a `showPaths` callback, parallel to the existing `showValue`.
