---
'@endo/stream': minor
---

Add `flatMapReader`, the stream analog of `Array.prototype.flatMap`, for
1-to-many reader transforms. The transform maps each value read from a reader
to an iterable — a synchronous array or iterable, or an async iterable /
sub-reader — and the elements are flattened into a single reader.

```js
const wordReader = flatMapReader(lineReader, line => line.split(/\s+/));
```

The identity transform flattens a reader of arrays into a reader of their
elements, turning a `Reader<T[]>` into a `Reader<T>`:

```js
const recordReader = flatMapReader(recordBatchReader, batch => batch);
```

Back-pressure is preserved: the inner iterable's values are emitted one at a
time as the consumer pulls them, and the next value is read from the upstream
reader only once the current group is exhausted, so the upstream is never
drained ahead of demand. Empty groups advance to the next source value, and
early `return`/`throw` and upstream termination propagate to both the inner
iterable and the upstream reader. This is the building block for 1-to-many
stream transforms such as parsing a stream of byte chunks into a stream of
newline-delimited records.
