---
'ses': minor
---

Tame and permit the host `URL` and `URLSearchParams` constructors, making them
available in every compartment.

- `URLSearchParams` is shared by every compartment. The otherwise hidden
  prototype of its iterators is now a permitted intrinsic, so it is hardened
  and one compartment cannot change how another iterates.
- The start compartment's `URL` keeps `URL.createObjectURL` and
  `URL.revokeObjectURL`. The `URL` of each compartment constructed after
  lockdown lacks them, since they grant authority over the host's blob
  registry. The two constructors share `URL.prototype`, so `instanceof URL`
  holds across compartments.
- The new lockdown option `urlBlobMethods: 'remove'` (or
  `LOCKDOWN_URL_BLOB_METHODS=remove`) removes the blob methods from the start
  compartment as well, leaving one `URL` shared by every compartment.
- On hosts without `URL` (XS), lockdown proceeds without it, as before.

Code that modifies `URL`, `URL.prototype`, or `URLSearchParams.prototype` after
lockdown will now throw, because they are frozen. Make such changes before
lockdown.
