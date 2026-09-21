---
'@endo/slots': minor
'@endo/eventual-send': minor
'@endo/capn-web': minor
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
unchanged, and the Rust supervisor treats the body as opaque bytes.

The OCapN data operations are now separate, non-overlapping lanes:
`E.get(target).field`, `E.index(target, index)`, and
`E.untag(target, tag)` dispatch through corresponding `HandledPromise`
handler methods (`index` and `untag` join the existing `get`) and distinct
slot-machine verbs. Gets reject arrays, indexes reject non-arrays, and untag
rejects a mismatched tag. No method named `__get__`, `index`, or `untag` can
intercept or impersonate a data operation.

Each data lane carries its own dedicated, compact canonical-CBOR payload
(`[target, scalar operand, reply]`) instead of reusing the opaque `deliver`
body, so a supervisor validates and translates the whole operation without
interpreting guest data. `reply` is required and must be a `Promise`
descriptor; a `Device` target is rejected; `index` is bounded to the
JavaScript array-index range. A malformed payload for a claimed data verb is a
protocol error and fails closed. The protocol has no version negotiation, so
all seven verbs (`deliver`, `get`, `index`, `untag`, `resolve`, `drop`,
`abort`) deploy together.

Cap'n Web remap paths encode canonical numeric property accesses as indexes and
replay numeric path segments with `HandledPromise.index`.
