---
'@endo/module-source': patch
'ses': patch
'@endo/compartment-mapper': patch
---

Pass a hardened `defineProperty` through the precompiled-module functor
calling convention so that hoisted function-name assignments (`F.name =
'F'`) are not broken when a module shadows `Object` via
`import { Object } from './x.js'`.

The functor calling convention gains a new field:

```js
({imports, liveVar, onceVar, defineProperty, import, importMeta}) => ...
```

`ses`'s `makeModuleInstance` and `@endo/compartment-mapper`'s `bundle`
output both pass the SES intrinsic `defineProperty` for this field.
`@endo/module-source` generates `$h͏_defineProperty(fn, 'name', {value:
'fn'})` in the functor preamble instead of `Object.defineProperty(...)`.

Compatibility note: a `module-source` that emits the new preamble
paired with an old `ses` or `compartment-mapper` will silently
fail to set function `.name` properties (the destructured field is
`undefined`).
The reverse pairing — new `ses` / `compartment-mapper` with an old
`module-source` — is harmless: the extra field is unused.
