# Sequential Syrup Message Framing (`@endo/syrup-frame`)

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Updated** | 2026-07-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Deprecated |
| **Superseded by** | [`ocapn-tcp-syrups-framing.md`](./ocapn-tcp-syrups-framing.md) (PR 29) |

## Status

This design is consolidated with PR 29's `@endo/syrup-frame`
([`ocapn-tcp-syrups-framing.md`](./ocapn-tcp-syrups-framing.md)), which
is the surviving design and the name that shipped (published
`@endo/syrup-frame` 0.1.1).
The two packages are the same in shape: each adapts a stream of
`Uint8Array` chunks into a stream of `Uint8Array`-delimited messages,
using length-prefixed Syrup byte-string framing on the wire
(`<digits>:<payload>`, no separator).

The earlier reading in this design (that the package proposed here was
a separate "message-stream" layer carrying decoded structured Syrup
values, one rung above PR 29's byte-string framer) was wrong.
Both the sibling `@endo/cbor-frame` design and PR 29's framer carry
`Uint8Array` at their boundaries; the value codec sits above either of
them, not inside.
Under the corrected reading, this design and PR 29's design describe
the same package, and only one need ship.
It shipped as `@endo/syrup-frame`.

## Naming

An earlier revision of this design recommended renaming PR 29's
`@endo/syrup-frame` to the plural `@endo/syrups`, by analogy to a
plural-of-format naming convention then under consideration for the
sibling CBOR framer.
That plural convention was later retired.
The package shipped under its original name, `@endo/syrup-frame`, and
the sibling CBOR framer shipped as `@endo/cbor-frame`: the two
streaming framers share the `-frame` suffix, which names the framing
role of each package, rather than a plural of the format being framed.

## Effect on the sibling `@endo/cbor-frame` design

[`cbor-frame.md`](./cbor-frame.md) (the sibling framing design) is
unaffected.
It already carries `Uint8Array` at its boundaries and is the precise
peer of `@endo/syrup-frame`, sharing the `-frame` suffix convention.

## Prompt

> Please dispatch a designer to propose two designs. I would like a
> design that creates a replica of the netstring proposal for sequential
> Syrup byte string messages (consider name: syrups) and a similar
> package that encodes and decodes sequential CBOR byte arrays.
