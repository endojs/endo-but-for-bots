---
'ses': patch
---

Resolves import bindings across cycles that pass through an `export *`
intermediary.
Previously, when module `A` did `export * from 'B'; export * from 'C'`
and `C` imported a name back from `A`, SES threw `SyntaxError: The
requested module 'A' does not provide an export named 'X'` because `A`
had not yet finished wiring its reexports when `C`'s `imports()` ran.

`makeModuleInstance` now exposes per-instance `isExecuting` and
`hasReexports` markers and an `ensureReexportNotifier` helper. When a
lookup misses on a module that is currently executing and has
`export *` declarations, SES installs a deferred TDZ-protected notifier
on the target. The notifier resolves when the target's own `imports()`
processes its exportAlls. If no source ever provides the binding, the
exports namespace's accessor throws `ReferenceError` at access time.

Module exports namespaces remain frozen, and all accessors stay
`set: undefined, configurable: false`.
