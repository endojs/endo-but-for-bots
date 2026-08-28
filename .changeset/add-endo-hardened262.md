---
'@endo/hardened262': major
---

Add `@endo/hardened262`, a [test262](https://github.com/tc39/test262)-style harness for **Hardened JavaScript** that verifies parity between the SES _shim_ and SES _specialized for native Hardened JavaScript on XS_.
It walks a bespoke Hardened JavaScript corpus with `test262-stream` and expands each case into a cross product of agents (`xs`, `sesXs`, `sesNode`, `ironhorse`, `sesIronhorse`), modes, `lockdown`, and `compartment`.
Its checked-in baseline lists skipped, failed, and passed tests by scenario, and CI rejects unacknowledged outcome changes.
Complementary to `@endo/test262-runner` (engine-conformance parity across a large corpus) rather than a duplicate of it.
