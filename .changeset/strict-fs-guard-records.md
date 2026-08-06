---
'@endo/platform': major
---

The extended filesystem guards now validate passable records against the
authored application types at the capability boundary.

Calls that previously passed only because an argument was accepted as any
passable value must now provide the documented shapes for stat patches, QIDs,
open and one-shot I/O options, lock requests and queries, extended-attribute
options, watch results, and blob information.
Unknown fields remain accepted on the tolerant-reader records, and option bags
whose implementations do not inspect their fields remain generic records.
The `Directory` and `Filesystem` guards also reject undeclared methods during
exo construction.
