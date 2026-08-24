---
'@endo/daemon': minor
---

Adds the daemon's shared core for the hash-anchored line-based edit format,
exported as the new public subpath `@endo/daemon/src/hashline.js`. It provides
2- or 4-character CRC-32 line anchors, SHA-256 whole-file compare-and-swap,
patch parsing and validation, deterministic splicing, and opt-in bounded anchor
relocation with structured failure and relocation reports. `applyEditPatch`
takes an injected `Sha256HexFn` digest power as a positional argument, so the
core stays pure and platform-neutral.

The subpath exports the value identifiers `EMPTY_FILE_SHA256`, `lineAnchorHash`,
`anchorHexWidthForLineCount`, `splitLines`, `joinLines`, `renderHashlineLines`,
`validateEditPatch`, `parseHashlineText`, and `applyEditPatch`, and the types
`HashlineAnchor`, `HashlineEditOpKind`, `HashlineEditOp`, `HashlineEditPatch`,
`HashlineAnchorMismatch`, `HashlineReapplyAmbiguity`, `HashlineEditFailure`,
`HashlineAnchorRelocation`, `HashlineEditResult`, `HashlineSpliceOutcome`,
`Sha256HexFn`, and `HashlineApplyEditOptions` (each re-exported from
`@endo/daemon`).
