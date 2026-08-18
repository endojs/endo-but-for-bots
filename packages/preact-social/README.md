# @endo/preact-social

Trusted-in-untrusted **social UI** for
[`@endo/preact-container`](../preact-container): render *your own* meaning of a
party a confined guest designates — a petname, an unspoofable trust badge —
without the guest reading, forging, or restyling it.

This package is the "carry trusted content into an untrusted guest" direction
of `confineComponent`, packaged as small, heavily-commented reference
implementations. Read [`PATTERNS.md`](./PATTERNS.md) for the coding discipline
these follow, and [`examples/`](./examples) for worked end-to-end usage.

> ⚠️ Like `@endo/preact-container`, this depends on SES `lockdown()` for its
> guarantees. Call `lockdown({ overrideTaming: 'severe' })` before evaluating
> any guest source.

## The idea

A confined component is a mutual-suspicion boundary. The container README
covers confining an untrusted guest; this package covers the other direction:

> the guest supplies the **designator** — a party OBJECT it was handed
> the host supplies the **meaning** — what the reader calls that party

The guest places `h(props.PetName, { party })`; the host resolves the name and
renders it; the guest never learns it and cannot draw a chip that would be
trusted in its place. Designation is **by reference** — a fabricated object is
not one the host's address book knows, so it renders as "unnamed".

## Install

```sh
yarn add @endo/preact-social @endo/preact-container preact
```

## `@endo/preact-social/petname`

```js
import { h } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import { makePetName } from '@endo/preact-social/petname';

// The address book maps party OBJECT → local name. Never handed to the guest.
const alice = harden({});
const book = new WeakMap([[alice, 'Alexa']]);
const PetName = makePetName(party => book.get(party), {
  // optional: make an unnamed chip activatable so the reader names the party.
  onName: party => promptForName(party),
});

// A confined guest weaves the chip into its content by party reference.
const Message = confineComponent(({ h: ch }, props) =>
  ch('p', null, 'Reply to ', ch(props.PetName, { party: props.author })),
);

renderConfined(h(Message, { PetName, author: alice }), container);
```

`makePetName(nameOf, opts?)` returns a confined chip. The guest reads no name
and cannot forge or restyle the chip; an unknown/fabricated party renders as
"unnamed", never as guest text. Mint it **once per address book**, not per
render.

## `@endo/preact-social/pattern-badge`

An unspoofable trust badge: a per-user pattern derived from a secret the guest
cannot observe, rendered only inside a confined component whose output the
guest cannot read — so an imitator draws blind.

```js
import {
  getOrCreatePatternSecret,
  makePatternBadge,
} from '@endo/preact-social/pattern-badge';

const secret = getOrCreatePatternSecret(localStorage, () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join(''),
);
const Badge = makePatternBadge(secret, { label: 'Grant request' });
// a confined guest places <Badge/> inline; the reader recognizes their pattern.
```

The guest may pass `text` (rendered *beside* the pattern, never inside it).
The badge fails to a **working** per-session pattern on storage denial, never
to "no pattern".

## `@endo/preact-social/party-mark`

```js
import { partyMark } from '@endo/preact-social/party-mark';
const { glyph, color } = partyMark(party); // stable per object; public
```

A stable, **public** glyph+colour keyed by the party object — it distinguishes
parties, it does **not** authenticate. Do not confuse it with the secret
pattern above.

## `@endo/preact-social/composition`

Render several parties' content inline in one document, each region attributed
to its source, with no party able to read another's input or output.

```js
import { composeRegions } from '@endo/preact-social/composition';
import { makePatternBadge } from '@endo/preact-social/pattern-badge';

const FrameBadge = makePatternBadge(secret, { label: 'Thread' }); // minted once
const tree = composeRegions(
  [
    { party: alice, Component: AliceWidget, props: { … } },
    { party: bram, Component: BramWidget, props: { … } },
  ],
  { nameOf: party => book.get(party), FrameBadge, label: 'Thread' },
);
renderConfined(tree, container);
```

The composition is trusted host chrome: the **frame** draws each attribution
mark itself (from `partyMark` and your `nameOf`), so a party is never handed
the means to claim another's name. **Sibling opacity** — one party cannot read
another's props or output — is inherited from `confineComponent`, not added
here. Each region's `Component` must be a confined component; a raw function is
visibly **refused**, never rendered with host authority under a party's mark. A
region with no `party` renders as *unattributed*, never inheriting a
neighbour's mark. The optional `FrameBadge` (a pattern badge minted once)
authenticates the composition itself.

## `@endo/preact-social/modifiers`

Composable input disciplines you layer over the function you confine (see
[`PATTERNS.md`](./PATTERNS.md) § 2):

- `withPrimitiveParams(fn)` — keep only primitive-valued props (value
  designators); drops the rest so an always-render component is never blanked.
- `withLimitedCss(fn)` — drop guest-supplied `style` / `class` / `className`
  so the component cannot be restyled or hidden.

```js
const Badge = confineComponent(withLimitedCss(withPrimitiveParams(render)));
```

## What this does not do

- It does not make a guest-drawn imitation *impossible* — it makes the real
  article *recognizable* (the pattern) and *unreadable/unforgeable* (the seal).
- It does not defend a user who never learns their pattern.
- It does not stop a party drawing a lookalike mark *inside its own region*; it
  stops that forgery being placed as the frame's attribution for another party
  (which the frame alone controls) and from being read across regions.

See `@endo/preact-container`'s `SECURITY-PROPERTIES` for the boundary's full
threat model and preconditions.

## Tests

```sh
yarn test
```

The suite runs the real components in headless Chromium (Vitest + Playwright),
written *as the attacks* — each test is a thing a hostile guest must not be
able to do.
