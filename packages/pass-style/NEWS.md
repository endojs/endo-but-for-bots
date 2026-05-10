User-visible changes in `@endo/pass-style`:

# Next release

- Add `makePromise()`: returns a frozen, non-thenable pass-style
  promise carrier that satisfies `passStyleOf(x) === 'promise'`. The
  carrier has no `then` method (own or inherited beyond
  `Object.prototype`), so `await passStylePromise` resolves to the
  carrier itself, never to a settlement target. Producers and
  subscribers synchronize on settlement only through an explicit
  operation in `@endo/eventual-send` (`HandledPromise.subscribe`,
  `HandledPromise.settle`, or `E.when`), closing the "then-pinhole"
  footgun (endojs/endo#2869).

  Native frozen `Promise` instances continue to satisfy
  `passStyleOf(p) === 'promise'`; the new shape is additive.

- Add `isPassStylePromise(x)`: distinguishes pass-style promise
  carriers (`true`) from native frozen promises (`false`).

- New `PassStylePromise` type alias and `(p: PassStylePromise):
  'promise'` overload on `PassStyleOf`.
