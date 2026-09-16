// The Ironhorse repairs the SES shim needs, evaluated before it.
//
// This file used to carry its own copy of them. It no longer does: they live in
// `@endo/ironhorse-prelude`, which `@endo/thixotrope`'s
// `scripts/bundle-ironhorse-worker.mjs` also bundles into the
// `dist-ironhorse/boot.js` the Ironhorse worker ships. Importing the same
// module is the point — it is what makes the `ses-xs-parity` corpus measure
// the shipped environment rather than a look-alike.
//
// The two copies had drifted on four points before the extraction, and one of
// them was load-bearing: the `harden` decision differed, which is why
// `lockdown()` worked in the worker and failed on the corpus.
//
// Anything Ironhorse-specific belongs THERE, not here. This file exists only to
// pull it in ahead of `ses/lockdown-shim.js`, and to hold whatever is genuinely
// specific to running test262 — which is currently nothing.
import '@endo/ironhorse-prelude';
