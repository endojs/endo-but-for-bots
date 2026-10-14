---
'ses': major
---

Permit a `Parcel` shim installed before `lockdown`.
SES retains the initial constructor, including privileged `locate`, in the
start compartment and derives a shared constructor for child compartments
that exposes only `open` and `isParcel`.
Both constructors share one prototype and brand table and are hardened at
lockdown; the shared prototype points back to the shared constructor.
