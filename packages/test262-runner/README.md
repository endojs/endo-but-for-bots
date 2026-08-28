# test262-runner

Run ECMAScript compliance tests on Node.js, XS, and Ironhorse (the XS→Rust port),
with a prelude that shims Hardened JavaScript on these platforms.

## Hosts

The `ses-xs-parity` axis runs against three hosts off one maintained subset:

* `yarn test262:xs` — XS via `xst` and the SES prelude.
* `yarn test262:node` — Node.js and the SES prelude.
* `yarn test262:ironhorse` — Ironhorse, the XS→Rust port, via its `endot-ih`
  runner in SES lockdown mode (`xst262.c`'s `-l`). endot-ih walks this same
  `test262/` tree filtered to `ses-xs-parity`, so no separate corpus is
  needed. Ironhorse's guest `lockdown()`/`Compartment` surface is still landing,
  so a case that needs it reports an honest named skip today and lights up as
  the surface lands; the run is green (zero failures) either way. Requires a
  Rust toolchain and the `c/moddable` submodule (the XS oracle endot-ih
  diffs against), the same XS dependency the `xs` host already needs.

See `designs/ironhorse-test262-convergence.md` for the convergence that
makes Ironhorse the third host.

## Test262 subset

The `test262` directory contains

* a copy of the `tests` and `harness` directories from https://github.com/tc39/test262.
* additional tests from https://github.com/Moddable-OpenSource/moddable
* additional Hardened JavaScript tests

We currently only run tests expressly marked with the `ses-xs-parity` feature
in their front-matter.

## Justification

Maintaining a local copy of tests taken at a given revision provides not only stability, it's also much faster on autobuilds than having to both checkout the test262 git repo and filter for relevant tests, and having to do so at every test run.

This technique is the same used by all major JavaScript engines:
- https://github.com/WebKit/webkit/tree/master/JSTests/test262
- https://github.com/v8/v8/tree/master/test/test262
- https://github.com/mozilla/gecko-dev/tree/master/js/src/tests/test262
etc.
