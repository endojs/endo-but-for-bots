---
'@endo/preact-social': minor
---

New package: trusted-in-untrusted **social UI** built on
`@endo/preact-container`. It packages the "carry trusted content into an
untrusted guest" direction of `confineComponent` as small reference
implementations, following designation-by-reference throughout (a party is a
WeakMap-keyed OBJECT, never a forgeable id):

- `@endo/preact-social/petname` — `makePetName(nameOf)`: a confined chip a
  guest places by party reference; the host resolves the reader's local name,
  which the guest can neither read nor forge. Unknown/fabricated parties render
  as "unnamed", never as guest text.
- `@endo/preact-social/pattern-badge` — `makePatternBadge` /
  `derivePattern` / `getOrCreatePatternSecret`: an unspoofable trust badge
  carrying a per-user pattern derived from a secret the guest cannot observe,
  failing to a working per-session pattern rather than to no pattern.
- `@endo/preact-social/party-mark` — `partyMark(party)`: a stable, public
  glyph+colour keyed by the party object (distinguishes, does not
  authenticate); deterministic, so no flaky collisions.
- `@endo/preact-social/modifiers` — `withPrimitiveParams` and `withLimitedCss`,
  composable input disciplines you layer over the function you confine.
- `@endo/preact-social/composition` — `composeRegions`: render several parties'
  confined content inline, each attributed by the trusted frame, with sibling
  opacity inherited from `confineComponent` and non-confined region content
  visibly refused.

Ships `PATTERNS.md` (the coding discipline for building trusted-in-untrusted UI
on `@endo/preact-container`), worked `examples/`, and attack-shaped browser
tests.
