---
'@endo/ocapn': major
---

Allow any trusted OCapN instance to forward a Parcel minted by another
instance in the same realm. Parcel location authority now comes from the
initial `Parcel.locate` intrinsic instead of a private per-client table.
