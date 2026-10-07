---
'@endo/daemon': minor
---

`@endo/daemon` now exports `makeFormulaNonceLocator` from `@endo/daemon/formula-nonce-locator.js`.
It is an OCapN nonce locator for `makeOcapn`'s `locator` option that resolves a presented canonical formula identifier to that formula's capability and reports every failure as one indistinguishable miss.
