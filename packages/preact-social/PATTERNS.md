# Coding discipline for trusted-in-untrusted UI

This package builds on `@endo/preact-container`.
The container gives you one primitive — `confineComponent` — that is a
**mutual-suspicion component boundary**: it protects the host from a
component's output (coercion + sanitization) *and* protects that output from
whoever holds the wrapper (a direct call returns `null`, the output reaches
only the DOM, the wrapper is identity-checked and cannot be forged).

That one primitive runs in two directions:

- **Confine an untrusted guest** — the guest's render results can never reach
  the DOM or inject HTML.
- **Carry trusted content into an untrusted guest** — the host wraps its *own*
  function (a petname, a trust badge, a confirmation) and hands the wrapper to
  a confined guest, which may place it but cannot read or forge it.

The helpers here (`makePetName`, `makePatternBadge`, `partyMark`) are the
second direction. The rules below are what keep them safe; follow them when
you build your own.

## 1. Designate by reference, never by id

A parameter that names a party should **be** the party — the object, passed by
reference — not a string id resolved through an ambient table.

```js
// RIGHT: the guest passes the party OBJECT it was handed; the host resolves it.
const book = new WeakMap([[alice, 'Alexa']]);
const PetName = makePetName(party => book.get(party));
//   guest writes:  h(props.PetName, { party: props.author })
//   a fabricated {} is simply not in the WeakMap → "unnamed"

// WRONG: a string id plus an ambient lookup.
const PetName = makePetName(id => addressBook.get(id)); // id is forgeable,
//   guest writes:  h(props.PetName, { id: 'did:key:z6Mk…' })  // and enumerable
```

Why: a string is forgeable (anyone who can guess or copy it designates the
same thing) and its lookup is ambient authority (a function that turns *any*
id into an object). A reference is held or not held; its identity *is* the
lookup key. An object also gives every party a stable identity even before it
has a name — which is why `partyMark` can badge an unnamed party consistently.

Unknown or fabricated designators must render as a fixed "unknown", **never**
as the raw designator (that teaches users to read ids as names) and **never**
as text the guest supplied (the fallback is the attack surface).

## 2. The trusted component owns its inputs

A confined component receives **attacker-provided** props — the same contract
as the arguments of a callback you hand a guest. The container does not screen
them, on purpose. Validate them yourself, and compose the discipline with the
modifiers in `./modifiers` rather than baking it into the boundary:

- `withPrimitiveParams` — where the parameters are value designators (a label,
  a timestamp, a count). It drops non-primitives, so an always-render
  component is never blanked by a hostile prop. Do **not** use it where a
  parameter is a party object designated by reference — an object is exactly
  what it drops.
- `withLimitedCss` — drops guest-supplied `style` / `class` / `className`, so
  the guest cannot restyle, recolour, or hide your component.

```js
const Badge = confineComponent(withLimitedCss(withPrimitiveParams(render)));
```

Two corollaries:

- **The component owns its handlers.** Never accept an `onClick` (or any
  behaviour) as a prop — a handler from the guest lets it decide what your
  button does inside chrome that looks like yours. Capture the handler in the
  closure (`makePetName`'s `onName`, `makeGrantCardExample`'s `onConfirm`).
- **`fn`'s output is still sanitized.** A `javascript:` URL or disallowed tag
  the component emits is dropped like any confined output. If trusted content
  genuinely needs un-sanitized output, use `HostPassthrough` deliberately.

## 3. Only `children` transcludes; carry host content as a component

The container makes `props.children` opaque sentinels the guest can place but
not inspect. A vnode passed through any **other** prop is rejected (it would
hand the guest live host component references). So carry host content as
`children`, or as a confined component the guest places — never as a raw vnode
in a data prop.

## 4. Recognition needs two halves

Confinement buys *faithful* — what the user sees is what the host rendered.
It does not buy *unspoofable* — nothing stops a guest drawing its own pixels
that imitate trusted chrome. For anything the user must trust (a confirmation,
a "funds received" badge), add a **security pattern**: a per-user rendering
derived from a secret the guest cannot observe (`makePatternBadge`). The guest
draws blind — it can draw a badge, not *your* badge.

- The secret's one job is to derive the rendering; never reuse it as a
  credential.
- The badge must fail to a **working** pattern, never to "no pattern" — a
  vanished badge trains the user to accept pattern-less prompts, which is the
  forgery. `getOrCreatePatternSecret` fails to a per-session secret.
- A public per-party **mark** (`partyMark`) is a *different thing* from the
  secret pattern: it distinguishes parties, it does not authenticate. Never
  mint a mark like a secret, or any party could draw its neighbour's.

## 5. Confine once per kind, not per render

A confined component registers as a trusted-exit type and is strongly
referenced for the life of the page. Mint `PetName` once per address book, a
badge once per secret — not inside a render.

## 6. SES lockdown is the precondition

All of this rests on `@endo/preact-container`'s precondition: call
`lockdown({ overrideTaming: 'severe' })` before evaluating any guest source.
Without it the boundary is decorative (see the container's README and
SECURITY-PROPERTIES). This package's `freeze` helper hardens its exports under
lockdown and falls back to a shallow freeze only so the browser test harness
can run.
