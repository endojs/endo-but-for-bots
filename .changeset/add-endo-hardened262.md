---
'@endo/hardened262': major
---

Add `@endo/hardened262`, a [test262](https://github.com/tc39/test262)-style
harness for **Hardened JavaScript** that verifies parity between the SES _shim_
and SES _specialized for native Hardened JavaScript on XS_. It walks a bespoke
Hardened JavaScript corpus with `test262-stream` and expands each case into a
cross product of agents (`xs`, `sesXs`, `sesNode`), modes, `lockdown`, and
`compartment`, reporting per-scenario pass/fail as a preliminary,
non-gating instrument. Complementary to `@endo/test262-runner` (engine-conformance
parity across a large corpus) rather than a duplicate of it.
