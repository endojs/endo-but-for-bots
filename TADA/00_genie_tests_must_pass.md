
The @endo/genie tests do not pass yet. Run them with:
```bash
$ yarn workspace @endo/genie run test
```

- [x] fix all the failures you find, committing one module and test at a time as you go
  - [x] drop `mustMatch` validation in `packages/genie/src/tools/common.js`
        (the `@endo/patterns` per-call guard requires hardened inputs and
        cascaded into 74 failures across the memory, filesystem, memory-fts5,
        and registry tool tests)
  - [x] align the `clear` builtin-special warn text with the test
        expectation (`Clear not supported in this deployment.`)
  - [x] track the auto-trigger IIFE on the observer so `stop()` reliably
        awaits a `check()`-driven cycle, and inject `logError` so tests
        can capture log lines without reassigning the (frozen-under-SES)
        global `console.error`
  - [x] mirror the same `logError` injection on the reflector and rewrite
        the two reflector tests that mutated `console.error`
  - [x] drop the no-SES default ava config from `packages/genie/package.json`
        (genie's tools transitively require SES, so loading the test files
        without it aborts at import time)

- **DO NOT** use `harden()`, it is okay for genie to be unhardened code in its current phase
  - [x] record that in your rules file (`CLAUDE.md` § "Exception:
        `@endo/genie` is unhardened in its current phase")

All three ses-ava configs (`lockdown`, `unsafe`, `endo`) now pass with
326 tests each.
