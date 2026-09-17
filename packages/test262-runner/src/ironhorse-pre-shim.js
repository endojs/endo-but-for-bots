// The Ironhorse repairs the SES shim needs, evaluated before it.
//
// This file used to carry its own copy of them. It no longer does: they live in
// `@endo/ironhorse-prelude`, which `@endo/thixotrope`'s
// `scripts/bundle-ironhorse-worker.mjs` also bundles into the
// `dist-ironhorse/boot.js` the Ironhorse worker ships. Importing the same
// module is the point — it is what makes the `ses-xs-parity` corpus measure
// the shipped environment rather than a look-alike.
//
// Anything Ironhorse-specific belongs THERE, not here. This file exists only to
// pull it in ahead of `ses/lockdown-shim.js`, and to hold whatever is genuinely
// specific to running test262 — which is currently nothing.
//
// In particular the pre-lockdown `harden` this corpus needs is NOT here: it is
// `./install-pre-lockdown-harden.js`, which must come AFTER the shim rather
// than before it. See that file for why the order decides which hardener the
// guest keeps.
import '@endo/ironhorse-prelude';
