# Sites flagged by no-harden-pattern-maker

Snapshot at 2026-04-24.

The rule was temporarily promoted from `warn` to `error` in
`packages/eslint-plugin/lib/configs/recommended.js`, after which a full
`yarn lint:eslint` and `yarn lint:workspaces:eslint` were run from the
repository root.

## Summary

**Total sites flagged across the monorepo: 0.**

| Package | Sites |
| --- | --- |
| (none) | 0 |

## Interpretation

No pre-existing source files in the Endo monorepo currently call
`harden(x)` on a value whose visible initializer is a Pattern maker
expression of the form `M.*(...)`.
This includes both the direct shape `harden(M.string())` and the
indirect shape:

```js
const StringShape = M.string();
harden(StringShape);
```

That is consistent with the convention already in force across the
codebase: every `export const Foo = M.something(...)` is left without
a follow-up `harden(Foo)`, and the matching change in this PR teaches
`@endo/harden-exports` to stop demanding one.

The rule will continue to earn its keep going forward by catching new
over-hardenings as soon as anyone writes one.

## Verification artifacts

- `lib/rules/no-harden-pattern-maker.js` — rule implementation.
- `test/no-harden-pattern-maker.test.js` — exhaustive valid/invalid
  coverage including the direct call shape, the binding shape inside a
  function body, the nested `M.arrayOf(M.string())` form, and a
  regression sanity check confirming the rule is silent for
  `harden(thirdPartyM.string())`.
- A live probe via `eslint.Linter` against
  ```js
  const a = M.string();
  harden(a);
  harden(M.string());
  ```
  produced two reports (one per call site), confirming the rule fires
  in both shapes when invoked.

## Reverted state

After capturing the empty result the rule was returned to its intended
default of `'warn'` in `recommended.js`.
