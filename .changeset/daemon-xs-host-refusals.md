---
'@endo/daemon': patch
---

The XS daemon's crypto and file powers now throw when an XS host function
answers with an `"Error: ..."` refusal, instead of returning the refusal text
as a digest, random value, key, or signature. `ed25519Sign` and a keypair's
`sign` previously decoded such a refusal into a mostly-zero signature.
