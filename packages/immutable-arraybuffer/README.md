# `@endo/immutable-arraybuffer`

A ponyfill and shim for the proposed
[Immutable ArrayBuffer](https://github.com/tc39/proposal-immutable-arraybuffer)
JavaScript feature, plus a companion ponyfill for
*freezable virtual TypedArrays* that view immutable buffers.

For most applications, reach for
[`@endo/bytes`](../bytes/README.md) rather than this package
directly. `@endo/bytes` installs a realm-wide "spackle" of these
operations at registered symbols on the intrinsics; consumers of
`@endo/bytes` get the realm-wide single-source-of-truth and a
codec that survives compartment-level `globalThis` tampering.
This package is the implementation surface that `@endo/bytes`
calls through to.

## Quick start

### Use the ponyfill exports

```js
import {
  sliceBufferToImmutable,
  isBufferImmutable,
  // Optional. May be undefined on platforms that lack both
  // structuredClone and ArrayBuffer.prototype.transfer
  // (Node <= 16, some JavaScriptCore versions, Hermes).
  optTransferBufferToImmutable,
} from '@endo/immutable-arraybuffer';

const ab = new ArrayBuffer(8);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);

// Copy a window into an immutable buffer.
const immutable = sliceBufferToImmutable(ab);
isBufferImmutable(immutable); // true

if (optTransferBufferToImmutable) {
  // Detaches `ab` and returns an immutable buffer with its bytes.
  const transferred = optTransferBufferToImmutable(ab);
  isBufferImmutable(transferred); // true
}
```

`x instanceof ArrayBuffer` returns `true` for both genuine and
emulated immutable buffers, so use `isBufferImmutable(x)` to ask
whether a particular buffer is immutable.

### Use the shim (opt-in)

Importing `@endo/immutable-arraybuffer/shim.js` modifies
`ArrayBuffer.prototype` to add the proposal's methods directly:

```js
// Import once at startup, before any application code that
// reaches for the proposal's methods.
import '@endo/immutable-arraybuffer/shim.js';

const ab = new ArrayBuffer(8);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);

const immutable = ab.sliceToImmutable();
immutable.immutable; // true
```

The shim is the right choice when source-compatibility with a
future native implementation of the *Immutable ArrayBuffer*
proposal is required. The ponyfill exports remain the right
choice when modifying intrinsics is not desired.

### Use freezable TypedArrays through `@endo/bytes`

The recommended path for `TypedArray` views onto immutable
buffers is through `@endo/bytes`'s spackle, which installs one
freezable constructor per realm at
`Uint8Array[Symbol.for('freezableConstructor')]` (and the
corresponding symbol on every other TypedArray constructor):

```js
// Application code reaches for @endo/bytes; the spackle's
// install dance happens at module load.
import { bytesToImmutable, bytesFromText } from '@endo/bytes';

const buffer = bytesToImmutable(bytesFromText('hello'));
const FreezableUint8Array = Uint8Array[Symbol.for('freezableConstructor')];
const view = new FreezableUint8Array(buffer);

// Indexed reads work as expected.
view[0]; // 104 ('h')

// Mutators throw because the backing buffer is immutable.
view.set([0]); // TypeError
```

The internal-implementation seam is at
`@endo/immutable-arraybuffer/freezable-typedarray-pony.js`,
where `makePseudoTypedArrayConstructor(OriginalConstructor)`
builds the constructor that the spackle then installs. Consumers
should not import from that path directly; the public surface is
`@endo/bytes`'s spackle install.

## API reference

### Named exports of `@endo/immutable-arraybuffer`

- `sliceBufferToImmutable(buffer: ArrayBuffer, start?: number, end?: number): ArrayBuffer`

  Returns a fresh immutable `ArrayBuffer` whose contents are a copy
  of the requested window. Honors the `start` and `end` arguments
  the same way `ArrayBuffer.prototype.slice` does. The result is
  *not* hardened by this package; consumers that want a hardened
  result should pass through `@endo/bytes`'s `bytesToImmutable`
  (which hardens) or call `harden` themselves.

- `isBufferImmutable(buffer: ArrayBuffer): boolean`

  Returns `true` when the given buffer is one this package
  produced (or, when the shim is installed, when the buffer's
  `immutable` accessor returns `true`).

- `optTransferBufferToImmutable(buffer: ArrayBuffer, newLength?: number): ArrayBuffer | undefined`

  Optionally available transfer operation. The function reference
  itself is `undefined` on platforms that lack both
  `structuredClone` and `ArrayBuffer.prototype.transfer`. Guard
  the call site if your code path is reachable on those
  platforms:

  ```js
  if (optTransferBufferToImmutable) {
    const result = optTransferBufferToImmutable(ab);
  }
  ```

### Shim additions to `ArrayBuffer.prototype`

Importing `@endo/immutable-arraybuffer/shim.js` adds these:

- `transferToImmutable(newLength?: number): ArrayBuffer` —
  detach the source, return an immutable buffer with its bytes.
- `sliceToImmutable(start?: number, end?: number): ArrayBuffer` —
  copy a window into an immutable buffer.
- `immutable: boolean` — read-only accessor returning `true` for
  immutable buffers.

The shim installs even when a native implementation later lands;
removing the shim after that is a separate manual decision (see
`tame-shim-best-practices` in this package's history).

## Feature detection

```js
import {
  isBufferImmutable,
  optTransferBufferToImmutable,
} from '@endo/immutable-arraybuffer';

// Will be defined on Node >= 17 (structuredClone) or
// Node >= 21 (ArrayBuffer.prototype.transfer); undefined on
// platforms that have neither.
const canTransfer = optTransferBufferToImmutable !== undefined;

// True when the immutable-ArrayBuffer shim or a native
// implementation is in effect.
const hasNativeOrShim = 'immutable' in new ArrayBuffer(0);
```

## Caveats

The shim's emulated immutable buffers do not match every aspect
of a native implementation:

- The ponyfill and shim require either `structuredClone` (Node
  >= 17) or `ArrayBuffer.prototype.transfer` (Node >= 21).
  Platforms with neither cannot initialize the package.
- Emulated immutable buffers inherit from an intermediate
  prototype (`immutableArrayBufferPrototype`) that a native
  implementation would not have. The intermediate prototype is
  discoverable as the buffer's direct prototype.
- Emulated immutable buffers are not real `ArrayBuffer` exotic
  objects. They cannot back a `DataView` or a genuine
  `TypedArray` view; reach for `@endo/bytes`'s freezable view
  for that.
- Emulated immutable buffers cannot be cloned or transferred
  between JS threads.
- The shim is not a *Hardened JavaScript* polyfill on its own. A
  program that runs `lockdown()` after the shim is responsible
  for hardening the produced objects (the SES shim does this
  during its harden phase).

### `Symbol.toStringTag` on the emulated prototype

`ImmutableArrayBufferInternal.prototype[Symbol.toStringTag]` is
set to `'ImmutableArrayBuffer'` to defeat Node's `concordance`
diagnostic-output sniff at
[concordance/lib/describe.js#L36](https://github.com/concordancejs/concordance/blob/791d2a89b40eb13f2c889ac270dd8be190cf8073/lib/describe.js#L36):
when the sniff matches `'ArrayBuffer'`, concordance tries
`Buffer.from(x)`, which only works on genuine buffers. Setting a
distinct tag avoids the match and keeps Ava's diagnostic output
correct. This is a purposeful violation of the fidelity goal,
documented to record why it is necessary.

## Relationship to `@endo/bytes`

Application code that wants the realm-wide single-source-of-truth
across compartments and eval twins should consume `@endo/bytes`
rather than reaching for this package's ponyfill exports
directly. The `@endo/bytes` spackle pattern (per
[its README](../bytes/README.md)):

- Installs the immutable-ArrayBuffer operations at registered
  symbols on `ArrayBuffer.prototype`, the codec operations at
  registered symbols on `Uint8Array`, and the freezable
  constructor at a registered symbol on every TypedArray
  constructor.
- Captures `TextEncoder` and `TextDecoder` once at module load,
  so a compartment global endowment that later replaces them on
  `globalThis` cannot redirect the codec.
- Ships an ESLint rule
  (`@endo/no-direct-codec-or-typedarray-constructor`) that
  forbids direct use of `new TextEncoder()`, `new TextDecoder()`,
  the TypedArray constructors, and `new ArrayBuffer()`, and
  points each call site at its `@endo/bytes` equivalent.

When the *Immutable ArrayBuffer* proposal lands natively on
`ArrayBuffer.prototype.sliceToImmutable` (and the other proposal
methods), `@endo/bytes`'s spackle prefers the standard install
over its own. The two pieces compose; they do not collide.

## Background and design notes

The *Immutable ArrayBuffer* proposal introduces a small surface:
one method (`transferToImmutable`) and one read-only accessor
(`immutable`) on `ArrayBuffer.prototype`. The Endo project's
interest in the proposal stems from two needs:

1. The OCapN network protocol treats byte arrays as a distinct
   form of bulk data to be transmitted by copy. Reflecting that
   shape well into JavaScript requires an immutable container of
   bulk binary data, which this proposal provides.
2. Moddable XS and similar embedded JavaScript engines target
   devices where ROM is more plentiful than RAM. They benefit
   from a standard way to place voluminous fixed data into ROM
   without going outside JavaScript's official semantics.

The full design discussion, including the rationale for the
spackle pattern, the symbol rendezvous shape, the lockdown-vs-shim
discipline, the XS/Node parity test strategy, and the migration
path for downstream packages, lives in
[`DESIGN.md`](./DESIGN.md). Consumers of the public API do not
need to read it; reviewers and contributors do.
