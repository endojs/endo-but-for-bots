---
'@endo/base64': minor
'@endo/bundle-source': patch
---

`@endo/base64` is now a hardened module: `index.js` imports `@endo/harden` and freezes its named exports (`encodeBase64`, `decodeBase64`, `atob`, `btoa`).
The shim path (`@endo/base64/shim.js` -> `./atob.js` / `./btoa.js`) remains free of `@endo/harden` so `@endo/init/pre.js` can install `globalThis.atob` / `globalThis.btoa` before SES `lockdown()` without poisoning the lockdown.

`@endo/bundle-source`'s `test/_sanity.js` defers its `@endo/base64`, `@endo/compartment-mapper`, and `bundle-source` imports until after the test's manual `lockdown()` call, so the hardened modules pick up SES's intrinsic `harden`.

(`@endo/base64` does not migrate to the ses-ava multi-config test pattern, even though the rest of this hex/xorshift stack does.  `@endo/init` already depends on `@endo/base64` at runtime via `@endo/init/pre.js -> @endo/base64/shim.js`, and listing `@endo/ses-ava` -- which depends on `@endo/init` -- as a base64 devDep would create the lerna release cycle `@endo/base64 -> @endo/ses-ava -> @endo/init -> @endo/base64`.  The package keeps its plain `ava` test runner.)
