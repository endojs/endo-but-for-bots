# @endo/sturdyref

A first-wins shim and ponyfill for **SturdyRefs**: opaque, passable references
to capabilities that can be enlivened later from a **locator record**. The shim
provides a single realm-shared, closely-held mapping from each sturdyref to its
locator, so that CapTP networks — including independently evaluated *eval twins*
of ocapn or captp — that share a realm can transport sturdyrefs and converge on
the same mapping.

## The shared namespace

The shim installs one namespace at `globalThis.SturdyRef`:

- `SturdyRef.fromLocation(locator)` — mint a fresh opaque sturdyref for a
  **locator record** and retain the `sturdyref → locator` mapping.
- `SturdyRef.toLocation(sturdyRef)` — recover the locator record a sturdyref was
  minted for (throws if the sturdyref is unknown to this realm).

A **locator record is an object**, never a string; it is not coupled to any
URL/URN scheme. The shim treats it opaquely — it only stores and returns it.

The mapping lives in a `WeakMap` closed over by the namespace, which is retained
by `globalThis`; the mapping is therefore **retained globally** for the life of
the realm. That global retention is the whole point: it is what lets separate
copies of a networking stack share one mapping.

## First-wins

Many copies of a ponyfill, ocapn, or captp may load in one realm. Each races to
install `globalThis.SturdyRef`, but only the **first** installation takes — it is
non-configurable and non-writable. Every later importer senses the existing
global and adopts it. So the realm ends up with exactly one `SturdyRef`
namespace and one shared mapping, and a sturdyref minted by one twin resolves
through any other.

## Ponyfill

```js
import { fromLocation, toLocation } from '@endo/sturdyref';

const sturdyRef = fromLocation(locatorRecord); // opaque, passable
const locator = toLocation(sturdyRef); // === locatorRecord
```

The ponyfill imports the shim and defers to `globalThis.SturdyRef`, so importing
it from an eval twin still converges on the one shared mapping. Importing the
ponyfill is safe before `lockdown`: it installs nothing until first used.

## Shim entry and `lockdown`

The namespace and every sturdyref are hardened by
[`@endo/harden`](../harden/README.md). When `lockdown` will be called, hardening
must happen **after** it, so installation is lazy — the ponyfill installs on
first use, which is after `lockdown` in normal use. To install eagerly in a
lockdown bootstrap, import the shim entry **after** `lockdown()`:

```js
import 'ses';
lockdown();
import '@endo/sturdyref/shim.js';
```

## Distributed confinement

- **No SES permit / withheld from child compartments.** `globalThis.SturdyRef`
  has no SES permit, so a child `Compartment` never receives it. The `SturdyRef`
  namespace — and each CapTP instance's enlivener — is closely held.
- **No location.** A confined guest that holds a sturdyref cannot read its
  locator: the locator lives only behind the closely-held WeakMap, never on the
  sturdyref (which is `passStyleOf`-opaque with no own properties leaking it).
- **No identification.** Two sturdyrefs minted for the same locator are distinct
  objects, so a guest cannot use a sturdyref to correlate or recover stable
  identity.
