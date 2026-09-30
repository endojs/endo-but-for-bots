# @endo/sturdyref

A first-wins shim and ponyfill for **SturdyRefs**: opaque references that can
be revived ("enlivened") into live references later. A SturdyRef is
constructed the way a `Proxy` or `HandledPromise` is, with a **handler** whose
`enliven` hook defines both what the ref captures and how it is revived.

This is layer 1 of the SturdyRef layering stack; the contract is
`designs/sturdyref-shim-contract.md`.

## The global constructor

```js
const ref = new SturdyRef({
  enliven(ref) {
    // `this` is the handler; return a live reference or a promise for one.
    return reviveFromWhateverThisHandlerCloses(ref);
  },
});

await SturdyRef.enliven(ref); // the hook's result
SturdyRef.isSturdyRef(ref); // true
```

- `new SturdyRef(handler)` requires a handler with an `enliven` method, which
  it reads once, at construction. It returns a fresh, frozen object with no
  own properties whose prototype is `SturdyRef.prototype`
  (`Object.prototype.toString` reports `[object SturdyRef]`). Calling
  `SturdyRef` without `new` throws.
- `SturdyRef.enliven(ref)` sends `enliven` to the ref: in a later turn it calls
  the hook as `handler.enliven(ref)` and settles with the result. A throwing
  hook, or an argument that is not a SturdyRef, yields a rejected promise.
- `SturdyRef.isSturdyRef(value)` is a brand check. It reveals nothing about
  what a ref captures.

What a SturdyRef captures is defined **entirely** by its handler: a CapTP, for
example, closes over its own peer id, swiss number, and hints. The handler is
held in a `WeakMap` inside the constructor and is never reachable from the
ref. Refs have **no identification**: two refs made from the same handler are
distinct. Any notion of "same referent" belongs to the handler.

A SturdyRef is not passable at this layer: `passStyleOf` rejects it.

## First-wins

Many copies of a ponyfill, ocapn, or captp may load in one realm. Each races to
install `globalThis.SturdyRef`, but only the **first** installation takes; it
is non-configurable and non-writable. Every later importer senses the existing
global and adopts it. The realm therefore has exactly one constructor, so a ref
minted by one copy is recognized and enlivened by any other.

## Ponyfill

```js
import { makeSturdyRef, enliven, isSturdyRef } from '@endo/sturdyref';

const ref = makeSturdyRef(handler); // new SturdyRef(handler)
const live = await enliven(ref);
```

The ponyfill defers to `globalThis.SturdyRef`, so importing it from an eval
twin still converges on the one shared constructor. Importing the ponyfill is
safe before `lockdown`: it installs nothing until first used.

## Shim entry and `lockdown`

Like the `HandledPromise` shim, the shim entry installs `globalThis.SturdyRef`
immediately and may be imported **before** `lockdown()`:

```js
import '@endo/sturdyref/shim.js';
import 'ses';
lockdown();
```

Before `lockdown`, the shim does not use [`@endo/harden`](../harden/README.md),
because a harden installed before `lockdown` makes `lockdown` throw. It freezes
the constructor, its prototype, and its statics, and leaves hardening to
`lockdown`. Once a harden is present (after `lockdown`, or after another
library installed one), it hardens with `@endo/harden` instead. Every ref is
frozen at construction.

Importing the shim after `lockdown()` also works, but then SES never sees the
constructor as an intrinsic (see below).

## Child compartments

The global confers no authority: construction only wraps a handler the caller
already has, the brand check reveals nothing, and `enliven` only runs the hook
of a ref the caller already holds. The shim takes no position on propagation
to child compartments; SES decides. A SES that permits `SturdyRef` admits a
constructor installed before `lockdown` as a shared intrinsic, hardens it, and
gives the same constructor to every child `Compartment`. A global installed
after `lockdown` stays in the start compartment only.
