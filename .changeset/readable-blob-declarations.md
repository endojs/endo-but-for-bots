---
'@endo/platform': patch
'@endo/daemon-cas': patch
'@endo/exo-git': patch
'@endo/agentry': patch
---

Correct the shared ReadableBlob declarations to describe the public Exo
methods while keeping the host-side CAS `readRange` helper out of generated Git
code-mode types.
Git blob declarations now expose their actual `sha256`, `size`, `bytes`,
`byteRange`, and `textRange` surface, matching the richer platform LocalBlob
contract.
