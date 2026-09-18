---
'@endo/helpdown': patch
---

`makeHelp` now looks up documentation with an own-property check instead of `in`, so a caller-supplied method name that only resolves through `Object.prototype` (`help('constructor')`, `help('toString')`) no longer returns an inherited primordial value that would trip the shared `help(method?) -> string` return guard; such names now fall back to the standard "no documentation available" string.
</content>
