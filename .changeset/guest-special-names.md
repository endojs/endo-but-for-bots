---
'@endo/daemon': minor
---

Endow a retained guest through a single `endowments` map from guest-side names
to the providing host's pet names. A key beginning with `@` is a special,
indelible endowment (such as replacing the default `@main` worker); any other
key is an ordinary, mutable introduction. The map's values are host pet names,
resolved to formula identifiers only behind the daemon boundary.
