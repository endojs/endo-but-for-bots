# Verify a design's stated foundation actually exists

## Trigger

A maintainer's review comment says something like
"we can do X with `@endo/foo` (with bar configured)" or
"build it on top of `@endo/baz`'s existing capability".
The phrasing assumes a foundation; the dispatch you receive
treats that assumption as ground truth.

## Why

Reviewers often describe the destination they want to reach,
not the current state of the foundation package.
The foundation may be missing the very feature the comment
takes for granted (deflate/inflate not configured;
async API not implemented; specific Exo not exposed).
If you forward the comment to a downstream designer or
builder without verifying, the design will be drafted
against a foundation that does not exist yet, the dependency
order will be wrong, and the eventual implementation PR will
either stall on an undisclosed prerequisite or silently
shrink scope to what the foundation can actually do.

## What to do

When you receive a directive that assumes a package has
capability `X`:

1. Read the foundation package's `package.json`, top-level
   `index.js`, and `README.md` for the relevant API surface.
2. Grep the source for the capability keywords
   (`deflate`, `inflate`, `compression`, `async`, etc.).
3. Read the `README.md` "Limitations" or "Roadmap" section,
   if present. Foundations often acknowledge missing pieces
   explicitly: "for expedience, X was dropped".
4. Confirm or refute the assumption.
5. If refuted: surface the gap in your reshape plan or
   dispatch as an explicit precondition. Do not silently
   forward the maintainer's wording. Either propose adding
   the prerequisite as a separate PR, or document why the
   feature can ship without it.

## Example

PR 128 review said:
"We can open a Zip in memory with `@endo/zip`
(with deflate/inflate configured)".

Reading `packages/zip/src/compression.js` revealed only
`STORE = 0` is defined.
`packages/zip/README.md` said: "For expedience, the
specialization dropped support for INFLATE compression.
The dependency would need to be converted to ECMAScript
modules".

The reshape plan called this out explicitly so the
downstream `@endo/exo-zip` design knows to either:
add deflate/inflate to `@endo/zip` first as a
prerequisite, or document the STORE-only constraint.

Without this precondition surfaced, the `@endo/exo-zip`
designer would assume the foundation already supported
compression, would not gate on the prerequisite, and the
implementation builder would discover the gap only when
trying to open a real-world (deflate-compressed) zip.

## Skills

- [`defer-stacking-on-in-flight-pr.md`](./defer-stacking-on-in-flight-pr.md)
  for the related case where the foundation exists but is
  mid-reshape rather than missing.
- [`verify-upstream-state-before-pinning.md`](./verify-upstream-state-before-pinning.md)
  for the analogous pattern with external upstream deps.
