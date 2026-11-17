---
'@endo/helpdown': patch
---

A caller-supplied method name that only resolves through `Object.prototype` (`help('constructor')`, `help('toString')`) now falls back to the standard "no documentation available" string instead of returning an inherited primordial value.
Previously such a name leaked the inherited value, which would trip the shared `help(method?) -> string` return guard.
`makeHelp` achieves this by looking up documentation with an own-property check (`Object.hasOwn`) instead of the prototype-walking `in` operator.
