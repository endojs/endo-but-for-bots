---
'@endo/platform': patch
'@endo/daemon-cas': patch
'@endo/exo-git': patch
'@endo/agentry': patch
---

Correct the shared ReadableBlob declarations to describe the public Exo
methods while keeping the host-side CAS `readRange` helper out of generated Git
code-mode types.
Git blob declarations now expose their actual `getInfo` content-address surface
and the `range` / `textRange` attenuation methods (a range of a blob is again a
readable blob — designs/readableblob-range-attenuation.md), the same rich shape
the platform `LocalBlob` carries.
