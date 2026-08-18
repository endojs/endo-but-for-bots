---
'@endo/platform': major
---

Extended filesystem posture recognition now uses same-vat instance testers
instead of a forgeable posture registry.
The package no longer exposes an unrestricted wildcard for extended filesystem
source modules, so internal posture construction helpers cannot be imported as
public deep subpaths.

`mountAsFilesystem` no longer asserts writable posture on behalf of the mount
it adapts: a read-only mount rejects mutation at its own boundary, so the
projected `Filesystem` now carries no posture unless the caller states one.
`chroot` likewise declines to copy an aggregate writable posture onto a
narrowed view whose selected subtree may be entirely read-only.
