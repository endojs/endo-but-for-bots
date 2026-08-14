---
'@endo/slots': minor
---

**BREAKING (wire protocol):** `deliver` bodies now carry one flat passable
argument vector, adopting the OCapN Body Content Format
(`packages/ocapn/docs/cbor-encoding.md`) instead of the previous
`[method, args]` pair and `__call__` sentinel.

- Function application (`E(fn)(...args)`) sends its arguments unchanged.
- String-named method invocation (`E(obj).method(...args)`) prepends the
  method's passable-symbol selector (`passableSymbolForName(method)`).
- Symbol-named methods have no wire selector and are rejected at the sender.

On receipt the target's shape decides dispatch, mirroring `@endo/ocapn`:
function Exos receive the complete argument vector via `applyFunction`; object
Exos validate and decode the leading selector, then dispatch the corresponding
string method via `applyMethod`. Descriptor translation and reply semantics are
unchanged, and the Rust supervisor is unaffected because it treats the body as
opaque bytes. The `__get__` property-access convention remains a private
slot-machine method call (see the README).
