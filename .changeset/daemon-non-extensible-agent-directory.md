---
'@endo/daemon': minor
---

`provideGuest` and `provideHost` accept a `nonExtensibleDirectory: true`
option that makes the new agent's own pet-name directory non-extensible, in
the sense of `Object.preventExtensions`: the agent can still resolve, rebind,
and remove the names it holds, including the `introducedNames` its host
endows, but any attempt by the agent to add a new name to its own directory
fails with a `TypeError`.  Directories the agent holds, such as `@pins`, stay
writable.  The setting is recorded on the agent formula, so it survives a
daemon restart, and `getFormula` reports it as a `nonExtensibleDirectory`
literal.
