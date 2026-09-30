---
'@endo/marshal': minor
'@endo/pass-style': minor
---

`@endo/marshal` now represents a SturdyRef in each of its encodings. A
SturdyRef occupies a slot, as a remotable or a promise does, and
`convertValToSlot` receives it, but its encoding names its kind so the decoder
can check what `convertSlotToVal` returns: `{"@qclass":"sturdyRef","index":N}`
in capdata, `"'N"` in smallcaps (the `'` prefix was reserved), and a `t`
prefix with an `encodeSturdyRef`/`decodeSturdyRef` option pair in
`encodePassable`. SturdyRefs sort as their own rank category, after strings
and before `null`, and all SturdyRefs tie. `decodeToJustin` renders one as
`sturdyRef(N)`, and the dot-membrane wraps one in a SturdyRef whose handler
enlivens the original across the membrane. The `Passable` type now includes
`SturdyRef`.
