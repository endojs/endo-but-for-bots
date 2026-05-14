# `@endo/chacha12-fast-check-test`

Integration test that drives `@endo/chacha12` as a `fast-check@4`
[`RandomGenerator`](https://github.com/dubzzz/pure-rand) via the
`randomType` parameter.

This package is **private**.
It is not published; it exists solely to validate that the
`{ next, getState, clone }` surface added to `@endo/chacha12`
plugs directly into `fast-check@4` (which delegates random
generation to `pure-rand@8`).

The production-shaped fast-check / pure-rand adapters live in the
sibling
[`@endo/random-fast-check`](../random-fast-check/README.md) package
(designed in
[`designs/random-pure-rand-v8-interface.md`](../../designs/random-pure-rand-v8-interface.md)).
This package is the integration smoke test that the chacha12 surface
required by that design is in fact present and correctly shaped.

## Why a separate package

Pulling `fast-check` into `@endo/chacha12` itself would couple a
small, focused keystream package to a much larger property-based
test framework, drag in `pure-rand`, and reverse the dependency
direction (`@endo/chacha12` is meant to be a **provider** of random
bytes, not a consumer of testing infrastructure).
A sibling integration-test package keeps `@endo/chacha12` standalone
while still proving the contract end-to-end.

The naming follows `fast-check`'s own spelling (lowercase, hyphen)
as published on npm.

## Running

```sh
cd packages/chacha12-fast-check-test
npx ava
```
