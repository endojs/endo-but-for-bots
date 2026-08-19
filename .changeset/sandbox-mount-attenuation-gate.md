---
'@endo/daemon': minor
---

Gate the sandbox slice's physical mount projection on the mount's denied
segments. A mount capability withholds well-known credential directories
(`.ssh`, `.aws`, `.gnupg`, …) by refusing to resolve them, but a kernel bind
mount hands a slice the backing directory itself, where that refusal no longer
applies. A granted mount whose effective denied set is non-empty is now served
to the slice over 9P — through the mount capability, which denies per segment —
instead of being bound directly; a mount minted with an explicitly empty denied
set keeps the direct bind. `getMountBacking` reports the effective denied set so
a host can make that distinction.
