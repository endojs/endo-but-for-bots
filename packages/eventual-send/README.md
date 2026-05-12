# `@endo/eventual-send`

Eventual send: a uniform async messaging API for local and remote objects.

## Overview

The **@endo/eventual-send** package provides the `E()` proxy for asynchronous
message passing.
Whether an object is in the same vat, a different vat, or across a network,
`E()` provides a consistent API that always returns promises.

This enables:
- **Uniform communication**: Same code for local and remote objects
- **Promise pipelining**: Chain operations without waiting for resolution
- **Message ordering**: Preserve message order per target
- **Future-proof code**: Local code works when migrated to distributed systems

## Shim

Eventual send relies on an Endo environment.
Programs running in an existing Endo platform like an Agoric smart contract or
an Endo plugin do not need to do anything special to set up HardenedJS,
HandledPromise and related shims.
To construct an environment suitable for Eventual Send requires the
`HandledPromise` shim:

```js
import '@endo/eventual-send/shim.js';
```

The shim ensures that every instance of Eventual Send can recognize every other
instance's handled promises.
This is how we mitigate, what we call, "eval twins".

## Architecture: ponyfill on `Promise` peer slots

The package installs a bank of related functions onto the realm-shared
`Promise` constructor, each at its own registered-symbol slot:

| Slot | Function |
|---|---|
| `Promise[Symbol.for('delegate')]` | `delegate(handler)` returns a settler bag for a new pending handled promise. |
| `Promise[Symbol.for('applyMethod')]` | `applyMethod(target, prop, args)` eventually invokes a method. |
| `Promise[Symbol.for('applyMethodSendOnly')]` | Fire-and-forget variant. |
| `Promise[Symbol.for('applyFunction')]` | `applyFunction(target, args)` eventually invokes a function. |
| `Promise[Symbol.for('applyFunctionSendOnly')]` | Fire-and-forget variant. |
| `Promise[Symbol.for('get')]` | `get(target, prop)` eventually reads a property. |
| `Promise[Symbol.for('getSendOnly')]` | Fire-and-forget variant. |
| `Promise[Symbol.for('resolve')]` | Wraps a value as a handled promise. |
| `Promise[Symbol.for('HandledPromise')]` | Back-compat: the constructor itself. |

The peer functions are siblings on `Promise`, not properties of any one
function.
This keeps the `delegate(handler)` slot aligned with the proposed TC39
`Promise.delegate` direction (a single function) while still exposing
the full dispatch surface.

Each slot is installed `configurable: false, writable: false`.
Two libraries that ship copies of the package race to install; the
first writer wins per slot, and subsequent module instances read the
slot and adopt the winner.
The slots are realm-wide: every compartment that shares the realm's
`Promise` sees the same peers.

The `delegate` slot has a forward-compatibility hook.
If a host or earlier shim has installed `Promise.delegate` (the
expected standard slot), the install path returns it without consulting
the registry symbol.

### Two import surfaces

| Import | When the install runs |
|---|---|
| `@endo/eventual-send/shim.js` | Eagerly at module load, before `lockdown()`. |
| `@endo/eventual-send` (main entry) | Lazily, on first call to any exported thunk. |

Both surfaces converge on the same realm-shared peers via the
registered-symbol slots, regardless of import order vs lockdown.

The eager shim must run before `lockdown()` because lockdown freezes
`Promise`.
A pre-lockdown writer arranges the slots; a post-lockdown reader
through the lazy main entry sees the slots already populated and
adopts.

### Lexical ponyfill thunks

The package main entry exports a lexical thunk for each peer:

```js
import {
  delegate,
  applyMethod,
  applyMethodSendOnly,
  applyFunction,
  applyFunctionSendOnly,
  get,
  getSendOnly,
  resolve,
} from '@endo/eventual-send';

const settler = delegate(handler);
const value = await get(target, 'x');
await applyMethod(target, 'greet', ['world']);
```

Each thunk on first call resolves the realm-shared
`Promise[Symbol.for(<name>)]` peer (installing it if absent), caches
the resulting function in module scope, and dispatches.
Subsequent calls go through the cached reference with one indirection.

This lets consumers write code that does not name a symbol or import
the install path directly; the thunks are the public API.

### `HandledPromise` back-compat

The legacy `HandledPromise` constructor surface remains:

```js
import { HandledPromise } from '@endo/eventual-send';

new HandledPromise((resolve, reject, resolveWithPresence) => { ... }, handler);
HandledPromise.resolve(x);
HandledPromise.applyMethod(t, p, a);
```

`HandledPromise` is a thin lazy adapter.
The constructor body forwards to `delegate(handler)` and wires the
executor up to the settler bag.
The static methods (`resolve`, `applyMethod`, `applyFunction`, `get`,
`getSendOnly`, etc.) are getters that defer to the realm-shared peers.

Reading any static returns the SAME function reference held by
`Promise[Symbol.for(<name>)]`, so identity assertions like
`E.resolve === HandledPromise.resolve === Promise[Symbol.for('resolve')]`
hold across both eager-shim and lazy-main paths.

The eager shim additionally writes `globalThis.HandledPromise` to the
realm constructor when the global is currently undefined, for legacy
consumers that read from the global.

### SES interaction

SES `lockdown()` permits each peer slot.
The permits enumerate `RegisteredSymbol(delegate)`,
`RegisteredSymbol(applyMethod)`, `RegisteredSymbol(applyFunction)`,
`RegisteredSymbol(get)`, etc. on the `Promise` constructor.
Without the permits, `lockdown()` would attempt to delete the
non-configurable slots and fail.

The pattern is strictly parallel to `@endo/harden`'s
`Object[Symbol.for('harden')]` slot, which SES permits at the same
intrinsic level.

## Importing

```javascript
import { E } from '@endo/eventual-send';
```

## Core API

### E(target).method(...args)

Eventual send: invoke a method, returning a promise for the result.

```javascript
import { E } from '@endo/eventual-send';

const counter = makeCounter(10);

// Send message, get promise
const resultP = E(counter).increment(5);
const result = await resultP;  // 15

// Works even if counter is a promise
const counterP = Promise.resolve(counter);
const result2 = await E(counterP).increment(3);  // 18
```

**Key property:** Works uniformly whether the target is:
- A local object
- A local promise for an object
- A remote presence in another vat
- A promise for a remote presence

All calls return promises, even for local objects, ensuring consistent async
behavior throughout your codebase.

### E.get(target).property

Eventual get: retrieve a property, returning a promise for its value.

```javascript
const config = harden({
  timeout: 5000,
  retries: 3
});

const timeoutP = E.get(config).timeout;
const timeout = await timeoutP;  // 5000
```

Useful for accessing properties on remote objects or promises.

### E.sendOnly(target).method(...args)

Fire-and-forget: send a message without waiting for or receiving the result.
Returns `undefined` immediately.

```javascript
const logger = makeLogger();

// Send log message, don't wait for result
E.sendOnly(logger).log('Event occurred');
// Continues immediately, logging happens eventually
```

**When to use:**
- Don't need the return value
- Want to optimize latency (no promise creation)
- Logging, notifications, fire-and-forget operations

**Note:** You won't get errors if the method fails.
Use regular `E()` if you need error handling.

### E.when(promiseOrValue, onFulfilled?, onRejected?)

Shorthand for promise handling with turn tracking:

```javascript
E.when(
  E(counter).getValue(),
  value => console.log('Value:', value),
  error => console.error('Error:', error)
);

// Equivalent to:
E(counter).getValue().then(
  value => console.log('Value:', value),
  error => console.error('Error:', error)
);
```

Primarily useful in contexts that need explicit turn tracking for debugging.

### E.resolve(value)

Convert a value to a handled promise:

```javascript
const promise = E.resolve(value);
// promise is a HandledPromise wrapping value
```

Usually not needed directly; `E()` handles this automatically.

## Promise Pipelining

One of the most powerful features is **promise pipelining**: the ability to
send messages to promises before they resolve.

```javascript
import { E } from '@endo/eventual-send';

// All of these send immediately - no waiting!
const mintP = E(bootstrap).getMint();
const purseP = E(mintP).makePurse();
const paymentP = E(purseP).withdraw(100);
await E(receiverPurse).deposit(100, paymentP);

// Only wait at the end for the final result
```

Without pipelining, you'd need to await each step:

```javascript
// Without pipelining: 4 round trips
const mint = await bootstrap.getMint();        // wait
const purse = await mint.makePurse();          // wait
const payment = await purse.withdraw(100);     // wait
await receiverPurse.deposit(100, payment);     // wait

// With pipelining: messages sent immediately, only wait at end
```

This can **dramatically reduce latency** in distributed systems by eliminating
round trips.

**How it works:**
- Messages to unresolved promises are queued
- When the promise resolves, queued messages are delivered in order
- Each message returns a new promise that resolves when the operation completes

## Why Eventual Send?

Eventual send provides four key benefits:

### 1. Uniform API

The same code works whether the target is local or remote:

```javascript
// This code works identically whether counter is:
// - A local object
// - In a different vat on the same machine
// - On a different machine across the network
const result = await E(counter).increment(5);
```

Write local code, deploy distributed, no changes needed.

### 2. Message Ordering

Messages to the same target are delivered and processed in send order:

```javascript
E(counter).increment(1);  // executed first
E(counter).increment(2);  // executed second
E(counter).increment(3);  // executed third
// Order is guaranteed
```

This simplifies reasoning about concurrency.

### 3. Pipeline Optimization

As shown above, eliminates round trips in distributed systems.

### 4. Future-Proof Code

Code written with `E()` works locally today and distributed tomorrow:

```javascript
// Works in development (local)
const result = await E(service).getData();

// Same code works in production (distributed)
// No changes needed when service moves to another vat/machine
```

## Integration with Exo

Exos (from [@endo/exo](../exo/README.md)) are the ideal targets for eventual
send:

```javascript
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';

const CounterI = M.interface('Counter', {
  increment: M.call(M.number()).returns(M.number())
});

const counter = makeExo('Counter', CounterI, {
  increment(n) {
    return count += n;
  }
});

// E() provides async wrapper
const resultP = E(counter).increment(5);

// The InterfaceGuard validates n is a number
// Even if counter is remote, validation happens on receive
```

Even for local exos, using `E()` provides benefits:
- **Consistent async behavior** throughout your codebase
- **Turn-based execution** prevents reentrancy bugs
- **Error isolation** via promise rejection
- **Future-proof** code that works when distributed

## HandledPromise

Under the hood, `E()` uses `HandledPromise`, a Promise subclass that supports
handler-based dispatch:

```javascript
import { HandledPromise } from '@endo/eventual-send';

// HandledPromise extends native Promise
const hp = new HandledPromise((resolve, reject, resolveWithPresence) => {
  // Three ways to settle the promise
  resolve(value);           // Normal resolution
  reject(reason);           // Rejection
  resolveWithPresence(h);   // Resolve with a remote presence
}, handler);

// Handler intercepts operations
const handler = {
  get(target, prop) { /* ... */ },
  applyMethod(target, verb, args) { /* ... */ }
};
```

**Most users don't need to use HandledPromise directly.**
The `E()` proxy provides the ergonomic interface, or call the lexical
ponyfill thunks (`delegate`, `applyMethod`, `applyFunction`, `get`,
`resolve`) for direct dispatch without the constructor-shaped facade.
See [Architecture: ponyfill on `Promise` peer slots](#architecture-ponyfill-on-promise-peer-slots)
above for the slot layout and lazy-vs-eager install behavior.

## Use in Tests

Use `E()` even in unit tests for consistency:

```javascript
import test from 'ava';
import { E } from '@endo/eventual-send';

test('counter increments correctly', async t => {
  const counter = makeCounter(0);

  // Use E() even though counter is local
  const result = await E(counter).increment(5);

  t.is(result, 5);
});
```

Benefits:
- Tests mirror production code
- Async behavior is tested
- Easy to mock remote objects
- Same code works for both local and remote targets

## Integration with Endo Packages

- **Foundation**: [@endo/pass-style](../pass-style/README.md) - What can be
  sent as arguments
- **Validation**: [@endo/patterns](../patterns/README.md) - Describe method
  signatures with InterfaceGuards
- **Defensive Objects**: [@endo/exo](../exo/README.md) - Exos are ideal targets
  for `E()`
- **Network Transport**: [@endo/captp](../captp/README.md) - Real network
  communication using CapTP

**Complete Tutorial**: See [Message Passing](../../docs/message-passing.md) for
a comprehensive guide showing how eventual-send works with pass-style, patterns,
and exo to enable safe distributed computing.

## Background

This package implements the
[ECMAScript eventual-send proposal](https://github.com/tc39/proposal-eventual-send),
which provides native language support for eventual send operations.

## See Also

- [ECMAScript eventual-send proposal](https://github.com/tc39/proposal-eventual-send)
- [Concurrency Among Strangers](http://www.erights.org/talks/thesis/) - Mark S.
  Miller's thesis on eventual send
- [@endo/captp](../captp/README.md) - Cap'n Proto RPC implementation for network
  transport
