// @ts-check
// prefer-endo-primitives-exempt: ignoreBOM preserves an interior U+FEFF.
/**
 * Shared range-attenuation maker for rich `ReadableBlob`s
 * (designs/readableblob-range-attenuation.md).
 *
 * `range(start, end)` and `textRange(startLine, endLine)` return a new,
 * ephemeral `ReadableBlob` with *exactly* the authority to read the selected
 * portion of the receiver. The returned value has the same interface, so
 * ranges compose: a range of a range intersects the two intervals and can
 * never regain authority outside the parent. Every ordinary read on an
 * attenuated blob (`text`, `json`, `streamBase64`, `getInfo`) applies only to
 * the selected bytes.
 *
 * `range` attenuates to a **byte** window without streaming more than the
 * window (a producer's `readWindow` reads only `[start, end)` from the source).
 * `textRange` attenuates to a **line** window, but locating LF boundaries
 * requires reading the receiver's current content: it reads the selected bytes
 * once to find the line offsets, then mints a byte-range blob over the located
 * span — so a `textRange` costs one extra whole-selection read over a bare
 * `range`, and on a *live* source the located byte offsets are frozen at call
 * time (see `textRange` below). The claim is byte windows without streaming the
 * whole file, not line windows.
 *
 * A derived `streamBase64` reads the selection in bounded byte sub-windows
 * (`BYTE_STREAM_CHUNK_SIZE` at a time) rather than buffering the whole
 * selection, so a narrowing of authority never widens the memory bound of the
 * read it derives from (`range(0n, huge).streamBase64()` streams; it does not
 * allocate the whole window). The whole-selection reads `text` / `json` /
 * `getInfo` genuinely need the whole selection, so they still read it in one
 * `readWindow` call.
 *
 * The maker is source-agnostic: a producer supplies a single
 * `readWindow(start, end)` primitive that reads the source's *current* bytes
 * in the absolute half-open interval `[start, end)` (clamped at end-of-content;
 * `end === undefined` means "to end-of-content") into a fresh backing buffer,
 * plus a `hashBytes` digest so the module stays free of any host `crypto`
 * import (keeping the `fs/lite` entry portable). A producer may additionally
 * supply `streamBytes`, a fresh whole-source stream that lets derived
 * `streamBase64` reads apply their window over one source read instead of
 * repeatedly materializing or reopening it. The base blob keeps its own
 * optimized whole-value
 * `text` / `json` / `streamBase64` / `getInfo`; only *derived* ranges route
 * every read through `readWindow`, and `makeBlobRangeMethods` returns the
 * `{ range, textRange }` pair a base blob spreads into its own methods.
 */

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';
import { decodeUtf8 } from '@endo/utf8/decode.js';

import { RichReadableBlobInterface } from './interfaces.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { RangeSource, RichReadableBlob } from './types.js' */

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const LF = 0x0a;

// Bound for byte chunks handed to the shared `PassableBytesReader` adapter.
// Shared with the `BlobRef` producer (which chunks its already in-memory bytes)
// so both ReadableBlob implementations have the same per-frame bound.
export const BYTE_STREAM_CHUNK_SIZE = 48 * 1024;

/**
 * Validate a `bigint` byte offset argument (`range`'s `start` / `end`): must be
 * a non-negative value representable in the safe-integer domain the backing
 * host APIs (`Uint8Array.slice`, `fs.read`) accept. A negative or non-safe
 * value rejects with `EINVAL`.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
const assertOffset = (value, name) => {
  if (typeof value !== 'bigint') {
    throw makeError(
      X`EINVAL: ${q(name)} must be a bigint, got ${q(typeof value)}`,
    );
  }
  if (value < 0n) {
    throw makeError(
      X`EINVAL: ${q(name)} must be non-negative, got ${q(value)}`,
    );
  }
  if (value > MAX_SAFE_INTEGER) {
    throw makeError(
      X`EINVAL: ${q(name)} ${q(value)} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  return value;
};

/**
 * Validate a `number` line-index argument (`textRange`'s `startLine` /
 * `endLine`): a non-negative safe integer, else `EINVAL`.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
const assertLineIndex = (value, name) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw makeError(
      X`EINVAL: ${q(name)} ${q(value)} is not a safe non-negative integer`,
    );
  }
  return value;
};

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
const minBigInt = (a, b) => (a < b ? a : b);

// A U+FEFF is a byte-order mark only when it is the first code point of the
// whole content. The single normative decode rule for every `ReadableBlob` read
// path (whole-value and derived window alike): a read whose selection begins at
// absolute byte offset 0 strips a leading BOM — which every whole-value producer
// already does, decoding through a default `TextDecoder` — while a selection
// beginning at any interior offset preserves a leading U+FEFF as literal
// content. This keeps text decoding position-independent, so a window's text is
// always the exact slice of the whole value's text — including a window that
// begins on an interior U+FEFF — and the documented identity
// `range(0n, size).text() === text()` holds on every producer. A default
// `TextDecoder` (used by `decodeUtf8`) strips a leading BOM regardless of the
// selection's absolute offset, so a non-zero-offset window needs a decoder that
// keeps it (`ignoreBOM: true`). See designs/readableblob-range-attenuation.md
// § Text ranges.
const bomPreservingTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Decode a selection's bytes as UTF-8 under the normative BOM rule above: strip
 * a leading U+FEFF only when this selection is the true start of content
 * (`selectionStart === 0n`); otherwise preserve it as literal content.
 *
 * @param {Uint8Array} bytes
 * @param {bigint} selectionStart  this selection's absolute start offset
 * @returns {string}
 */
const decodeSelectionText = (bytes, selectionStart) =>
  selectionStart === 0n
    ? decodeUtf8(bytes)
    : bomPreservingTextDecoder.decode(bytes);

/**
 * Yield an already-materialized `Uint8Array` in fixed-size byte chunks. The
 * shared chunker for producers whose bytes are already fully in memory
 * (`BlobRef`); the maker's own derived stream reads incrementally instead (see
 * `streamByteWindow`), so it does not use this.
 *
 * @param {Uint8Array} bytes
 */
export async function* chunkBytes(bytes) {
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BYTE_STREAM_CHUNK_SIZE
  ) {
    const end = Math.min(offset + BYTE_STREAM_CHUNK_SIZE, bytes.length);
    yield bytes.subarray(offset, end);
  }
}

/**
 * Yield the absolute byte interval `[start, end)` of `readWindow`'s source in
 * bounded sub-windows so an attenuated stream never buffers more than one chunk
 * at a time. A read that returns fewer bytes than requested signals
 * end-of-content (the `readWindow` contract clamps at end-of-content), which
 * ends the stream. The public `streamBase64` method delegates these byte arrays
 * to `bytesReaderFromIterator`, which owns the wire encoding contract.
 *
 * The reads are *lazy*: the first `readWindow` call happens on the generator's
 * first advance, so a consumer that obtains the stream but never iterates it
 * leaves no unobserved promise — and no unhandled rejection.
 *
 * @param {Readonly<RangeSource>} source
 * @param {bigint} start
 * @param {bigint | undefined} end
 */
async function* streamByteWindow(source, start, end) {
  await null;
  const { readWindow, streamBytes } = source;
  if (streamBytes !== undefined) {
    // A source-native stream amortizes setup/materialization over the entire
    // range read. `copyByteWindow` rechunks it at the byte-stream bound and
    // gives every chunk a fresh backing buffer.
    yield* copyByteWindow(streamBytes(), start, end);
    return;
  }
  const chunk = BigInt(BYTE_STREAM_CHUNK_SIZE);
  let position = start;
  for (;;) {
    if (end !== undefined && position >= end) {
      return;
    }
    // Clamp the sub-window end into the safe-integer domain, matching
    // `intersectInterval`'s composed-offset clamp. Without this, an open-ended
    // selection whose `position` sits within one chunk of `MAX_SAFE_INTEGER`
    // (a legitimate empty attenuation, e.g. `range(MAX_SAFE)`) would compute a
    // `windowEnd` past `MAX_SAFE_INTEGER`, which `readWindow` rejects with
    // EINVAL instead of short-reading to empty. Content cannot exist past
    // `MAX_SAFE_INTEGER`, so clamping there still reads to end-of-content.
    const windowEnd =
      end === undefined
        ? minBigInt(position + chunk, MAX_SAFE_INTEGER)
        : minBigInt(position + chunk, end);
    if (windowEnd <= position) {
      // The selection begins at or past the safe-integer domain: no content
      // can exist here, so the stream is empty.
      return;
    }
    const requested = windowEnd - position;
    // eslint-disable-next-line no-await-in-loop
    const bytes = await readWindow(position, windowEnd);
    if (bytes.length === 0) {
      return;
    }
    yield bytes;
    position += BigInt(bytes.length);
    if (BigInt(bytes.length) < requested) {
      // Short read: the source ended within this sub-window.
      return;
    }
  }
}

/**
 * Select `[start, end)` from a whole-source byte stream and yield copied,
 * fixed-size chunks. No yielded `Uint8Array` shares its backing buffer with a
 * source chunk, including when the source is a Node `Buffer` whose `.slice()`
 * would otherwise retain the whole allocation.
 *
 * @param {AsyncIterable<Uint8Array>} source
 * @param {bigint} start
 * @param {bigint | undefined} end
 */
export async function* copyByteWindow(source, start, end) {
  let sourcePosition = 0n;
  let output = new Uint8Array(BYTE_STREAM_CHUNK_SIZE);
  let outputLength = 0;

  for await (const sourceChunk of source) {
    const sourceChunkEnd = sourcePosition + BigInt(sourceChunk.length);
    if (sourceChunkEnd <= start) {
      sourcePosition = sourceChunkEnd;
    } else {
      if (end !== undefined && sourcePosition >= end) {
        break;
      }

      const selectionStart =
        start > sourcePosition ? Number(start - sourcePosition) : 0;
      const selectionEnd =
        end !== undefined && end < sourceChunkEnd
          ? Number(end - sourcePosition)
          : sourceChunk.length;
      let selectionPosition = selectionStart;
      while (selectionPosition < selectionEnd) {
        const copyLength = Math.min(
          selectionEnd - selectionPosition,
          output.length - outputLength,
        );
        output.set(
          sourceChunk.subarray(
            selectionPosition,
            selectionPosition + copyLength,
          ),
          outputLength,
        );
        outputLength += copyLength;
        selectionPosition += copyLength;
        if (outputLength === output.length) {
          yield output;
          output = new Uint8Array(BYTE_STREAM_CHUNK_SIZE);
          outputLength = 0;
        }
      }
      sourcePosition = sourceChunkEnd;
      if (end !== undefined && sourcePosition >= end) {
        break;
      }
    }
  }

  if (outputLength > 0) {
    // Trim the final allocation without retaining the unused capacity.
    yield output.slice(0, outputLength);
  }
}

/**
 * Given the receiver's currently-selected bytes and a zero-based, end-exclusive
 * line interval `[startLine, endLine)`, compute the half-open **byte** span
 * within the selection whose UTF-8 decoding equals
 * `text.split('\n').slice(startLine, endLine).join('\n')` — the exact
 * `rangeReadText` contract, so `textRange(a, b).text()` and the retired
 * `rangeReadText(a, b)` never disagree. Line boundaries are LF (`0x0a`); a CR
 * before LF stays content (CRLF preserved); a final LF yields a terminal empty
 * line, and selecting through it preserves that LF.
 *
 * Only the two bounding LF offsets are needed — the LF ending line
 * `startLine - 1` (whose next byte begins the first selected line) and the LF
 * ending line `endLine - 1` (the exclusive upper byte bound) — so a single scan
 * captures just those two rather than materializing every LF offset. The two
 * branches guarantee `from <= to`, so no reversal is possible and no defensive
 * min/max is needed.
 *
 * @param {Uint8Array} bytes  the receiver's selected bytes
 * @param {number} startLine
 * @param {number} endLine
 * @returns {[number, number]}  `[from, to)` byte offsets relative to `bytes`
 */
const lineByteSpan = (bytes, startLine, endLine) => {
  if (endLine <= startLine) {
    return [0, 0];
  }
  // Line `k` begins right after the `(k-1)`th LF (line 0 at byte 0); lines
  // `[startLine, endLine)` end just before the LF terminating line `endLine - 1`
  // (or at end-of-content when that line is the final, unterminated one, or when
  // a start/end index is past the last line).
  const fromLfIndex = startLine - 1; // consulted only when startLine > 0
  const toLfIndex = endLine - 1;
  let from = startLine === 0 ? 0 : bytes.length;
  let to = bytes.length;
  let needFrom = startLine !== 0;
  let needTo = true;
  let lfCount = 0;
  for (let i = 0; i < bytes.length && (needFrom || needTo); i += 1) {
    if (bytes[i] === LF) {
      if (needFrom && lfCount === fromLfIndex) {
        from = i + 1;
        needFrom = false;
      }
      if (needTo && lfCount === toLfIndex) {
        to = i;
        needTo = false;
      }
      lfCount += 1;
    }
  }
  return [from, to];
};

/**
 * Build the attenuated `ReadableBlob` exo for the absolute byte interval
 * `[absoluteStart, absoluteEnd)` (`absoluteEnd === undefined` means "to
 * end-of-content") over `source`. `source` is the hardened internal record
 * `makeBlobRangeMethods` snapshotted once, so `readWindow` cannot be swapped out
 * from under an already-issued attenuated blob.
 *
 * @param {Readonly<RangeSource>} source
 * @param {bigint} absoluteStart
 * @param {bigint | undefined} absoluteEnd
 * @returns {RichReadableBlob}
 */
const makeAttenuatedBlob = (source, absoluteStart, absoluteEnd) => {
  const { readWindow, hashBytes, label = 'ReadableBlob range' } = source;
  // Copy at the shared attenuation boundary even when a producer accidentally
  // returns a `subarray` view. This is defense in depth with the RangeSource
  // contract: no derived method retains an unattenuated backing allocation.
  const readSelectedBytes = async () =>
    new Uint8Array(await readWindow(absoluteStart, absoluteEnd));

  /**
   * Absolute interval for a sub-selection `[start, end)` relative to this
   * receiver, intersected with `[absoluteStart, absoluteEnd)` so authority can
   * only ever narrow. An `end` of `undefined` inherits this receiver's own end
   * (the sub-selection runs to this receiver's end-of-authority). Both
   * endpoints are clamped to this receiver's end: clamping only the end (and
   * not the start) could mint an inverted interval `composedStart >
   * composedEnd` — e.g. a nested `range(N, …)` whose `N` lands past this
   * receiver's end — which would surface later as a spurious `EINVAL`/overflow
   * at read time instead of the intended empty selection.
   *
   * On an **open-ended** receiver (`absoluteEnd === undefined`) there is no
   * end to clamp to, yet `absoluteStart + start` (and, when `end` is given,
   * `absoluteStart + end`) still sum two individually valid offsets whose
   * *sum* can exceed `MAX_SAFE_INTEGER` — a nested open-ended `range(MAX)` of a
   * `range(MAX)`. So both composed endpoints are additionally clamped into the
   * safe-integer domain every `readWindow` accepts; a start clamped there is
   * past any real end-of-content, i.e. the intended empty selection, rather than
   * an offset that fails far later at `readWindow`'s bigint→Number boundary. The
   * invariant is enforced here, at the single construction site.
   *
   * @param {bigint} start
   * @param {bigint | undefined} end
   * @returns {[bigint, bigint | undefined]}
   */
  const intersectInterval = (start, end) => {
    let composedStart = absoluteStart + start;
    let composedEnd;
    if (end === undefined) {
      composedEnd = absoluteEnd;
    } else if (absoluteEnd === undefined) {
      composedEnd = absoluteStart + end;
    } else {
      composedEnd = minBigInt(absoluteStart + end, absoluteEnd);
    }
    if (absoluteEnd !== undefined) {
      composedStart = minBigInt(composedStart, absoluteEnd);
    }
    // Clamp both endpoints into the safe-integer domain. When `absoluteEnd` is
    // defined the clamps above already bound both by `absoluteEnd`
    // (≤ MAX_SAFE_INTEGER), so this only bites the open-ended case, where a
    // summed offset can overflow. The clamp is monotonic, so it preserves
    // `composedStart <= composedEnd`.
    composedStart = minBigInt(composedStart, MAX_SAFE_INTEGER);
    if (composedEnd !== undefined) {
      composedEnd = minBigInt(composedEnd, MAX_SAFE_INTEGER);
    }
    return [composedStart, composedEnd];
  };

  return makeExo(label, RichReadableBlobInterface, {
    /** @param {ERef<unknown>} synPromise */
    streamBase64(synPromise) {
      // Read the selection in bounded sub-windows rather than buffering the
      // whole selection: an attenuated `streamBase64` must not exceed the
      // memory bound of the read it derives from. The window read is deferred
      // into the generator (`streamByteWindow` is lazy), so a consumer that
      // never iterates leaves no unobserved rejection.
      return bytesReaderFromIterator(
        streamByteWindow(source, absoluteStart, absoluteEnd),
      ).streamBase64(/** @type {any} */ (synPromise));
    },
    async text() {
      return decodeSelectionText(await readSelectedBytes(), absoluteStart);
    },
    async json() {
      const text = decodeSelectionText(
        await readSelectedBytes(),
        absoluteStart,
      );
      try {
        return JSON.parse(text);
      } catch (cause) {
        // A bare `JSON.parse` error ("Unexpected end of JSON input", "Expected
        // ':' …") names neither the blob nor the interval — and an empty
        // selection (what a mis-ordered or past-EOF range yields) is exactly the
        // case a caller hits most. Name the source and the selected interval.
        const endLabel =
          absoluteEnd === undefined ? 'end-of-content' : absoluteEnd;
        throw makeError(
          X`Cannot parse JSON from ${q(label)} selection [${q(absoluteStart)}, ${q(endLabel)})`,
          undefined,
          { cause: /** @type {Error} */ (cause) },
        );
      }
    },
    // The `{ algorithm, hash, size }` triple of the *selected* content: for an
    // immutable source a stable content address for the selected bytes; for a
    // live source, the identity of the bytes at this call within the interval.
    // The read + digest are O(n) in the selection on every call and are not
    // memoized: the shared maker is source-agnostic and, on a live source, the
    // bytes (and thus the content address) can change between calls, so caching
    // here would risk returning a stale address. An immutable producer that
    // wants to amortize the digest memoizes it at its own layer (a scoped
    // follow-up), where the immutability that makes memoization sound is known.
    async getInfo() {
      const bytes = await readSelectedBytes();
      return harden({
        algorithm: 'sha256',
        hash: encodeBase64(hashBytes(bytes)),
        size: BigInt(bytes.length),
      });
    },
    /**
     * @param {bigint} start
     * @param {bigint} [end]  omit to select from `start` to end-of-content
     */
    async range(start, end) {
      assertOffset(start, 'start');
      if (end !== undefined) {
        assertOffset(end, 'end');
        if (end < start) {
          throw makeError(
            X`EINVAL: start ${q(start)} must not exceed end ${q(end)}`,
          );
        }
      }
      const [composedStart, composedEnd] = intersectInterval(start, end);
      return makeAttenuatedBlob(source, composedStart, composedEnd);
    },
    /**
     * @param {number} startLine
     * @param {number} endLine
     */
    async textRange(startLine, endLine) {
      assertLineIndex(startLine, 'startLine');
      assertLineIndex(endLine, 'endLine');
      if (endLine < startLine) {
        throw makeError(
          X`EINVAL: startLine ${q(startLine)} must not exceed endLine ${q(endLine)}`,
        );
      }
      // Locate the line boundaries in the receiver's *current* bytes, then mint
      // a byte-range blob over the located span. NOTE: on a *live* source these
      // byte offsets are resolved once, here; a later read on the returned blob
      // reads the source's then-current bytes at those *byte* offsets, which may
      // no longer be the same *lines* if the content changed. On a live face a
      // line grant can therefore decay into a byte grant — the mutable-source
      // producers (daemon `EndoMountFile`) and `RichReadableBlob.textRange`'s
      // type doc state this divergence.
      const bytes = await readSelectedBytes();
      const [from, to] = lineByteSpan(bytes, startLine, endLine);
      const [composedStart, composedEnd] = intersectInterval(
        BigInt(from),
        BigInt(to),
      );
      return makeAttenuatedBlob(source, composedStart, composedEnd);
    },
    /** @param {string} [method] */
    help(method) {
      return method === undefined
        ? 'ReadableBlob range: attenuated read of a byte/line selection (text, json, streamBase64, getInfo, range, textRange).'
        : `No documentation for method ${q(method)}.`;
    },
  });
};
harden(makeAttenuatedBlob);

/**
 * The `{ range, textRange }` attenuation methods a rich base blob spreads into
 * its own methods object. The base blob keeps its own whole-value reads; only
 * the derived ranges these methods mint route reads through `readWindow`.
 *
 * The `source` record is snapshotted and hardened once here, so a producer that
 * retains the record it passed cannot swap `readWindow` (or `hashBytes`) out
 * from under an attenuated blob it has already handed to a less-trusted holder —
 * every range that holder derives reads through the frozen primitive.
 *
 * @param {RangeSource} source
 * @returns {{ range: (start: bigint, end?: bigint) => Promise<RichReadableBlob>, textRange: (startLine: number, endLine: number) => Promise<RichReadableBlob> }}
 */
export const makeBlobRangeMethods = source => {
  const {
    readWindow,
    streamBytes,
    hashBytes,
    label = 'ReadableBlob range',
  } = source;
  const internalSource = harden({ readWindow, streamBytes, hashBytes, label });
  const base = makeAttenuatedBlob(internalSource, 0n, undefined);
  return harden({
    range: (start, end) => base.range(start, end),
    textRange: (startLine, endLine) => base.textRange(startLine, endLine),
  });
};
harden(makeBlobRangeMethods);
