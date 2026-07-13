# Sequential Syrup Message Framing (`@endo/syrup-frame`)

> **Proposed a rename to `@endo/syrups`; not adopted.** This design
> recommended renaming `@endo/syrup-frame` to `@endo/syrups` for parity
> with a plural `@endo/cbors`. That rename was reversed: both framing
> siblings shipped under the explicit `-frame` suffix —
> `@endo/syrup-frame` (already on `llm`) and `@endo/cbor-frame`
> ([PR #288](https://github.com/endojs/endo-but-for-bots/pull/288),
> proposed as `@endo/cbors`). The package name is `@endo/syrup-frame`.

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Updated** | 2026-07-13 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Deprecated |
| **Superseded by** | [`ocapn-tcp-syrups-framing.md`](./ocapn-tcp-syrups-framing.md) (PR 29) |

## Status

This design is consolidated with PR 29's `@endo/syrup-frame`
([`ocapn-tcp-syrups-framing.md`](./ocapn-tcp-syrups-framing.md)).
The two packages are the same in shape: each adapts a stream of
`Uint8Array` chunks into a stream of `Uint8Array`-delimited messages,
using length-prefixed Syrup byte-string framing on the wire
(`<digits>:<payload>`, no separator).

The earlier reading in this design (that `@endo/syrups` was a separate
"message-stream" layer carrying decoded structured Syrup values, one
rung above PR 29's byte-string framer) was wrong.
Both `@endo/cbor-frame` (the sibling design in this PR) and
`@endo/syrup-frame` (PR 29) carry `Uint8Array` at their boundaries;
the value codec sits above either of them, not inside.
Under the corrected reading, the package this design once called
`@endo/syrups` and PR 29's `@endo/syrup-frame` are the same package;
only one need ship, and it shipped as `@endo/syrup-frame`.

## Recommendation

**Historical recommendation (not adopted):** rename the package and
design from `@endo/syrup-frame` to `@endo/syrups`, so that the two
streaming message-framing packages in this PR pair would share a
plural-of-format naming convention (`@endo/cbors` and `@endo/syrups`).

**What actually landed:** the rename was reversed. Both framing
siblings kept (or adopted) the explicit `-frame` suffix —
`@endo/syrup-frame` (already on `llm`) and `@endo/cbor-frame`
([PR #288](https://github.com/endojs/endo-but-for-bots/pull/288),
proposed as `@endo/cbors`) — because the `-frame` suffix reads
unambiguously as "framing" and keeps `@endo/cbor` (the codec) from
colliding with a plural `@endo/cbors` one letter away. The package
name is `@endo/syrup-frame`.

## Effect on the sibling `@endo/cbor-frame` design

[`cbors.md`](./cbors.md) (the sibling design in this PR, proposed as
`@endo/cbors`, landed as `@endo/cbor-frame`) is unaffected.
It already carries `Uint8Array` at its boundaries and is the precise
peer of `@endo/syrup-frame`.

## Prompt

> Please dispatch a designer to propose two designs. I would like a
> design that creates a replica of the netstring proposal for sequential
> Syrup byte string messages (consider name: syrups) and a similar
> package that encodes and decodes sequential CBOR byte arrays.
