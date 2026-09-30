---
'@endo/daemon': major
'@endo/cli': patch
---

BREAKING: `provideGuest` endows every guest through a single `endowments` map
from guest-side names to the providing host's pet name paths, replacing the
guest `introducedNames` option (which mapped host names to guest names in the
opposite direction). A key beginning with `@` is a special, indelible
endowment (such as replacing the default `@main` worker) accepted only when the
guest is created; any other key is an ordinary, mutable introduction. The map's
values are pet name paths (arrays of path components, even for a single name),
never bare strings and never formula identifiers; the daemon resolves them to
formula identifiers behind its boundary. For a retained guest the whole map is
part of the immutable retained policy. `provideHost` still accepts
`introducedNames`. The `endo mkguest --introduce hostName:guestName` flag is
unchanged and now translates to `endowments`.
