---
'@endo/captp': patch
'@endo/marshal': minor
'@endo/pass-style': minor
'@endo/patterns': patch
'@endo/spaces-util': patch
---

`@endo/marshal` now represents a SturdyRef in each of its encodings.
A SturdyRef occupies a slot, as a remotable or a promise does, and `convertValToSlot` receives it, but its encoding names its kind so the decoder can check what `convertSlotToVal` returns: `{"@qclass":"sturdyRef","index":N}` in capdata, `"'N"` in smallcaps (the `'` prefix was reserved), and a `t` prefix with an `encodeSturdyRef`/`decodeSturdyRef` option pair in `encodePassable`.
A capdata `slot` that decodes to a SturdyRef is rejected, so a SturdyRef cannot be passed off as a remotable or a promise by reusing its slot index.
SturdyRefs sort as their own rank category, after strings and before `null`, and all SturdyRefs tie, which shifts the rank-cover indexes `@endo/patterns` reports for later categories.
`@endo/patterns` treats a SturdyRef as neither a key nor a pattern, as it does a promise.
`decodeToJustin` renders one as `slotToSturdyRef(v)` when its slot resolves and as `sturdyRefSlot(N)` otherwise, and the dot-membrane wraps one in a SturdyRef whose handler enlivens the original across the membrane, passing both its fulfillment and its rejection.
The `Passable` type now includes `SturdyRef`, and the `@endo/pass-style/tools.js` arbitraries generate SturdyRefs when the realm has one, unless `excludePassStyles` names `sturdyRef`.
`@endo/spaces-util` renders a SturdyRef instead of throwing on it, and `@endo/captp` refuses to send one until CapTP gives it a slot kind of its own.
