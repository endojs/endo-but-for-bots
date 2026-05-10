User-visible changes in `@endo/eventual-send`:

# Next release

- Add `HandledPromise.subscribe(x, onFulfilled, onRejected?)`: the
  fire-once, callback-based primitive that observes the eventual
  settlement of `x`. Cases:
  - A pass-style promise carrier (the non-thenable token from
    `@endo/pass-style`'s `makePromise()`): the subscriber is registered
    with the carrier's producer; when the producer settles via the
    kit's `settle`/`reject` (or a host-driven external resolution),
    subscribers fire on the next turn.
  - A native Promise or HandledPromise: delegates to `.then`.
  - Any other passable: `onFulfilled(x)` fires on the next turn,
    delivering the value verbatim.

  An omitted `onRejected` rethrows on the next turn into the host's
  unhandled-rejection path. Settlement is final on the carrier
  (fire-once); subscribers added after settlement still fire on the
  next turn with the recorded outcome.

- Add `HandledPromise.settle(x)`: the promise-returning convenience
  layered on `subscribe`. Returns a native Promise that fulfills with
  the eventual settlement value (or rejects with the eventual
  rejection reason) of `x`, recursively walking through chains of
  pass-style promises, native Promises, and HandledPromises until a
  non-promise Passable is reached. For a native Promise, this is
  equivalent to `Promise.resolve(p)`.

- Add `makeSubscribableKit()`: returns `{ promise, settle, reject }`
  where `promise` is a fresh pass-style promise carrier and
  `settle`/`reject` drive subscriber notification through the
  package's internal producer registry. Use this when you want to
  expose a subscribable token to downstream consumers without
  exposing the resolver.

- Add `resolveExternalPassStylePromise(carrier, target)` and
  `rejectExternalPassStylePromise(carrier, reason)`: bridges for
  hosts (CapTP slot tables, liveSlots-equivalents) that mint
  carriers via `@endo/pass-style`'s `makePromise()` directly and
  drive settlement through their own out-of-band channels. Calling
  one of these settles the producer record so downstream
  `HandledPromise.subscribe` / `HandledPromise.settle` callers
  observe the resolution.

- `E.when(x, onfulfilled, onrejected)` is re-implemented in terms
  of `HandledPromise.settle(x).then(onfulfilled, onrejected)`. The
  observable behavior on a native Promise is unchanged; the new
  implementation also walks chains of pass-style carriers without
  introducing implicit `await` synchronization on each hop.

## Migration note for liveSlots-style consumers

Code that today maintains a `WeakMap<Promise, kref>` and synthesizes
opaque-but-thenable native promises as kref carriers can collapse to
a direct `makePromise()`/slot mapping:

```js
// Before
const promiseRefMap = new WeakMap();
export const kslot = (kref, iface) => {
  if (isPromiseRef(kref)) {
    const p = new Promise(() => undefined);
    promiseRefMap.set(p, kref);
    return harden(p);
  }
  return Far(iface, { toString: () => `${kref}` });
};

// After
export const kslot = (kref, iface) => {
  if (isPromiseRef(kref)) {
    return makePromise();  // no WeakMap; the token is opaque
  }
  return Far(iface, { toString: () => `${kref}` });
};
```

The kslot/krefOf pair becomes symmetric with the remotable case,
and consumers downstream observe a non-thenable token (so `await
inboundKref` is not an implicit synchronization across the cap
boundary). Drive settlement via
`resolveExternalPassStylePromise(carrier, target)`.
