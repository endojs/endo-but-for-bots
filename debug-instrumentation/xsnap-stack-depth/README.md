# Endo beta2-vs-beta3 stack-depth bisection (xsnap overflow investigation)

**Scratch / diagnostic only. Bot-fork preservation, no PR, no upstream interaction.**

Preserved from the garden investigation
`investigate-beta3-ymax0-xs-repro-and-fix`, which traced an XS (xsnap) stack
overflow during `agoric-sdk` ymax0 v320 durable-kind rehydration. This is the
Endo half — the bisection that **ruled Endo out** as the regression cause.

## Finding

The overflow path is the recursive `@endo/pass-style` descent
(`passStyleOfRecur → passStyleOfInternal → assertRestValid`, ~3 non-tail frames
per nesting level), reached by `marshal` unserialize and patterns
`mustMatch`/`checkMatches`. Running an identical V8 depth probe against the two
Endo sets:

| path                       | beta2 set | beta3 set |
| -------------------------- | --------- | --------- |
| `passStyleOf`              | 2047      | 2047      |
| `marshal` round-trip       | 1790      | ≈1791     |
| `mustMatch`                | 511       | 511       |

**Frames-per-level are identical** — the `ses`/`pass-style` bump did not change
the recursion shape (the 1.6.3→1.8.1 `pass-style` diff is a Checker→Rejector
rename). The overflow is an XS native-stack-depth property (XS ≈ 350 non-tail
frames vs V8's thousands), **not** an Endo regression. Actionable fix is
contract-side depth-bounding, not Endo.

- **beta2 set:** `ses@1.15.0`, `@endo/pass-style@1.6.3`, `@endo/patterns@1.7.0`,
  `@endo/marshal@1.8.0` (parent of agoric-sdk regression commit `3952deecd4`).
- **beta3 set:** `ses@2.2.0`, `pass-style@1.8.1`, `patterns@1.9.1`,
  `marshal@1.10.0`.

## Files (verbatim survivors from `/tmp/endo-beta2/`)

- `package.json` — pins the **beta2** Endo set; swap to the beta3 versions above
  to reproduce the other column.
- `probe.mjs` — the V8 binary-search depth probe (`passStyleOf` / `marshal` /
  `mustMatch` over a right-nested record). `node probe.mjs`.
- `probe-entry.js` — the in-XS module (`passStyle`/`marshalRT`/`matchD` exports)
  bundled and evaluated inside an xsnap worker so XS-vs-V8 is apples-to-apples.
- `init-entry.js`, `es-shim-entry.js` — lockdown + eventual-send shim entries
  bundled into the worker.

The companion XS-side probe (`scratch-xs-depth.mjs`, which runs `probe-entry.js`
inside a real xsnap worker) lives in the agoric-sdk bot fork at
`packages/xsnap/debug-instrumentation/` since it needs the built xsnap.

Commit identity is the bot (`endolinbot`).
