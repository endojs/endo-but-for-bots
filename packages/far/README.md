# Endo Far Object helpers

**Deprecated.** `@endo/far` was a *plain re-exporter*: it re-exported names
that originate in other packages without renaming them or adding value. Per
[endojs/endo-but-for-bots#543][543] those re-exports have been removed. Import
each name directly from the package that originally exports it:

```js
import { E } from '@endo/eventual-send';
import { Far, getInterfaceOf, passStyleOf } from '@endo/pass-style';
```

The `FarRef`, `ERef`, `EOnly`, `EReturn`, and `EResult` types likewise come
from `@endo/eventual-send`.

[543]: https://github.com/endojs/endo-but-for-bots/issues/543
