// @ts-check
/* eslint-disable no-await-in-loop -- ordered streaming: directory entries
   and file chunks are applied sequentially to preserve tree order and
   bound memory; parallelising would reorder the single frame stream. */
/**
 * Streaming clone for `@endo/platform` extended fs (designs/endo-app-sharing.md, Pillar 3c).
 *
 * A clone ships a whole source tree to a destination as **one ordered
 * stream of entries** — `(path, kind, content)` in depth-first order —
 * rather than a client-driven pipelined walk that pays a round-trip per
 * node. The producer (which already holds the tree) serialises it into a
 * single `PassableReader<CloneFrame>`; the consumer drains that one reader
 * and recreates the tree under a destination `Directory`.
 *
 * Design decisions realised here:
 *
 * - **One stream, not a pipelined walk.** `streamTree` returns a single
 *   reader regardless of file count; `@endo/exo-stream`'s pre-ack `buffer`
 *   keeps the pipe full over a high-latency link.
 * - **No content hashing.** Integrity and peer-authenticity are the
 *   transport's job (the secure channel established when the peer was
 *   added). The clone path computes no per-blob hash and does no CAS dedup.
 * - **Large files stream as chunk frames** within the one stream, so no
 *   whole file is buffered in memory.
 * - **Pluggable durable destination.** The consumer writes through an
 *   ordinary `Directory` cap, so the durable backing is whatever
 *   `Filesystem` the caller hands in (in-memory, node-fs, a zip-backed
 *   `FsBackend`, …).
 *
 * Bytes ride inside frames as base64 strings because CapTP marshalling
 * rejects raw mutable typed arrays (see DESIGN.md §5 / §6); this mirrors
 * how `@endo/exo-stream`'s byte reader/writer haul bytes today.
 */

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { M } from '@endo/patterns';
import { decodeBase64 } from '@endo/base64/decode.js';
import { encodeBase64 } from '@endo/base64/encode.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

/**
 * @typedef {object} CloneFrame
 * A single frame in the depth-first clone stream.
 * - `{ kind: 'dir', path }` — ensure a directory exists at `path`.
 * - `{ kind: 'file', path }` — begin a file at `path`.
 * - `{ kind: 'chunk', base64 }` — append bytes to the file most recently
 *   opened by a `file` frame.
 * - `{ kind: 'fileEnd' }` — close the current file.
 */

/**
 * Pattern for a single clone frame. Passed to `readerFromIterator` as the
 * `readPattern` so a malformed frame breaks the stream at the boundary
 * rather than corrupting the destination tree.
 */
export const CloneFrameShape = M.or(
  harden({ kind: 'dir', path: M.arrayOf(M.string()) }),
  harden({ kind: 'file', path: M.arrayOf(M.string()) }),
  harden({ kind: 'chunk', base64: M.string() }),
  harden({ kind: 'fileEnd' }),
);
harden(CloneFrameShape);

/**
 * Stable, name-sorted directory listing so a clone is reproducible.
 * Sorts by UTF-16 code point (not `localeCompare`, whose order varies by
 * environment locale) so the traversal order is deterministic everywhere.
 *
 * @param {any} dir  a `Directory` cap (local or remote)
 * @returns {Promise<Array<{ name: string, qid: { type: string } }>>}
 */
const listSorted = async dir => {
  const cursor = await E(dir).list();
  const entries = await E(cursor).toArray();
  return [...entries].sort((a, b) => {
    const an = String(a.name);
    const bn = String(b.name);
    // eslint-disable-next-line no-nested-ternary
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
};

/**
 * Depth-first generator of clone frames for a directory's contents.
 * Children are emitted relative to the original source root (the root
 * directory itself is implied by the destination and gets no frame).
 *
 * @param {any} dir  a `Directory` cap
 * @param {string[]} prefix  path of `dir` relative to the source root
 * @returns {AsyncGenerator<CloneFrame, void, void>}
 */
async function* harvestTree(dir, prefix) {
  const entries = await listSorted(dir);
  for (const { name, qid } of entries) {
    const path = harden([...prefix, name]);
    const child = await E(dir).lookup(name);
    if (qid.type === 'directory') {
      yield harden({ kind: 'dir', path });
      yield* harvestTree(child, path);
    } else {
      yield harden({ kind: 'file', path });
      const open = await E(child).open({ read: true });
      try {
        // `read(0n)` is offset 0, length-to-EOF (DESIGN.md §4.6); the
        // bytes reader yields transport-sized chunks we re-frame one
        // for one, so no whole file is buffered.
        const bytesReader = await E(open).read(0n);
        for await (const chunk of iterateBytesReader(bytesReader)) {
          yield harden({ kind: 'chunk', base64: encodeBase64(chunk) });
        }
      } finally {
        await E(open).close();
      }
      yield harden({ kind: 'fileEnd' });
    }
  }
}

/**
 * Serialise a source tree as a single `PassableReader<CloneFrame>`.
 *
 * @param {any} sourceRoot  the `Directory` cap at the root of the tree to
 *   clone (e.g. `await E(filesystem).root()` or any sub-`Directory`)
 * @param {{ buffer?: number }} [options]  `buffer` is the exo-stream pre-ack
 *   depth: the producer streams up to this many frames ahead of consumer
 *   demand, so a drain costs about `frameCount / buffer` synchronization
 *   round-trips rather than one ack per frame (a large file fans out into
 *   many `chunk` frames). Defaults to 64; set 0 for strict per-frame
 *   backpressure, or higher to trade more in-flight frames (memory) for
 *   fewer round-trips on a high-latency link.
 * @returns {any}  a `PassableReader` cap over `CloneFrame`s
 */
export const streamTree = (sourceRoot, options = {}) => {
  const { buffer = 64 } = options;
  return readerFromIterator(harvestTree(sourceRoot, harden([])), {
    buffer,
    readPattern: CloneFrameShape,
  });
};
harden(streamTree);

/**
 * Resolve (creating as needed) the destination `Directory` that should
 * contain `path`'s leaf, returning `{ parent, name }`.
 *
 * @param {any} destRoot  destination `Directory` cap
 * @param {string[]} path  non-empty path relative to `destRoot`
 * @returns {Promise<{ parent: any, name: string }>}
 */
const resolveParent = async (destRoot, path) => {
  path.length >= 1 || Fail`clone frame path must be non-empty`;
  const name = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  const parent =
    parentPath.length === 0
      ? destRoot
      : await E(destRoot).materialise(harden(parentPath), {});
  return { parent, name };
};

/**
 * Drain a clone stream into a destination `Directory`, recreating the
 * source tree. Returns counts for progress reporting.
 *
 * @param {any} destRoot  the `Directory` cap to clone into
 * @param {any} reader  a `PassableReader<CloneFrame>` (from `streamTree`)
 * @returns {Promise<{ directories: number, files: number, bytes: number }>}
 */
export const writeTreeStream = async (destRoot, reader) => {
  let directories = 0;
  let files = 0;
  let bytes = 0;

  /** @type {any} */
  let openFile;
  // The exo-stream byte writer (BytesWriterIterator) is iterator-shaped but
  // not a full AsyncGenerator (no [Symbol.asyncDispose], 0-arg return()), so
  // it is kept loosely typed.
  /** @type {any} */
  let writer;

  try {
    // Validate frames on the consumer side too. `writeTreeStream` drains an
    // arbitrary reader (possibly remote/untrusted), so enforce the frame shape
    // at the stream boundary rather than failing deep in a switch case — or
    // worse, feeding a non-string into `decodeBase64`.
    for await (const frame of iterateReader(reader, {
      readPattern: CloneFrameShape,
    })) {
      switch (frame.kind) {
        case 'dir': {
          !writer || Fail`clone stream: dir frame while a file is open`;
          frame.path.length !== 0 || Fail`clone stream: dir frame empty path`;
          await E(destRoot).materialise(harden(frame.path), {});
          directories += 1;
          break;
        }
        case 'file': {
          !writer || Fail`clone stream: nested file frame`;
          const { parent, name } = await resolveParent(destRoot, frame.path);
          // Truncate: a clone overwrites the destination wholesale, so an
          // existing longer file at this path must be shortened. `create`
          // truncates only with this flag, and `OpenFile.write` is pwrite
          // (no tail truncate), so without it a re-clone into a non-empty
          // destination would leave stale trailing bytes.
          openFile = await E(parent).create(name, { truncate: true });
          writer = iterateBytesWriter(await E(openFile).write(0n));
          files += 1;
          break;
        }
        case 'chunk': {
          writer || Fail`clone stream: chunk frame with no open file`;
          const data = decodeBase64(frame.base64);
          bytes += data.length;
          await writer.next(data);
          break;
        }
        case 'fileEnd': {
          writer || Fail`clone stream: fileEnd with no open file`;
          await writer.return();
          await E(openFile).close();
          writer = undefined;
          openFile = undefined;
          break;
        }
        default: {
          throw Fail`clone stream: unknown frame kind ${frame.kind}`;
        }
      }
    }
    !writer || Fail`clone stream: ended mid-file`;
  } finally {
    // On a mid-stream error (malformed frame, source read failure) close the
    // partially-written destination file rather than leaking the OpenFile and
    // its abandoned writer.
    if (writer) {
      await writer.return().catch(() => {});
      await E(openFile)
        .close()
        .catch(() => {});
    }
  }

  return harden({ directories, files, bytes });
};
harden(writeTreeStream);

/**
 * Clone a source tree into a destination `Directory` as a single
 * streamed pass. Convenience over `writeTreeStream(dest, streamTree(src))`;
 * works whether `source` and `dest` are local or across a CapTP boundary,
 * since everything flows through the one reader cap.
 *
 * @param {any} sourceRoot  the `Directory` cap to clone from
 * @param {any} destRoot  the `Directory` cap to clone into
 * @param {{ buffer?: number }} [options]
 * @returns {Promise<{ directories: number, files: number, bytes: number }>}
 */
export const cloneTree = (sourceRoot, destRoot, options = {}) =>
  writeTreeStream(destRoot, streamTree(sourceRoot, options));
harden(cloneTree);
