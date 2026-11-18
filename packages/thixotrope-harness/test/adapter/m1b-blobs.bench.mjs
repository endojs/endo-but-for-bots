// @ts-check
/**
 * Node benchmark of the blob store (M1b W1b.1; m1b-interfaces.md section
 * 4): write and read throughput for 1 MiB and 10 MiB texts, the cost of
 * one staged field on the hot path, and the restart resolve. No vat and no
 * Ironhorse workload, so it needs no run lock; files go to a temporary
 * directory under the harness `tmp/` (same disk as state directories).
 * Rows are JSON lines through `perf/_harness.mjs` (`PERF_OUT` appends them).
 *
 *   node test/adapter/m1b-blobs.bench.mjs
 *
 * Metrics (`size` 1 MiB and 10 MiB of ASCII; `mbps` = MiB/s of the median):
 * - `blobs.stage`: `BlobStore.stage(text)`: write, fsync, rename, fsync of
 *   the directory, bind (what the Composer and the provider pay).
 * - `blobs.read`: `BlobStore.read(blob)`, whole text in process (the
 *   context cache, echo, the gateway).
 * - `blobs.readPages`: every page of `blobPageBytes` through the `Content`
 *   exo (`E(content).read`), as the exec vat reads a source, without the
 *   hub hop.
 * - `blobs.writer`: `BlobWriters.open`, `append` pieces of `blobPieceBytes`,
 *   `close` (the exec vat's path for a large result, without the hub hop).
 * - `blobs.stage.field` (`size` 9 KiB, 32 KiB, 96 KiB): one staged field,
 *   BLOB_FIELDS samples (default 200): the latency a staged reply, argument
 *   or tool result adds before its message is sent; the stock refill is
 *   included where it falls (one manager crank per 32, here a local call).
 * - `blobs.resolve`: a fresh incarnation resolving 600 handles
 *   (`resolveMany`, 10 calls of 64) and stat-ing their files.
 * - `blobs.stream` (`size` 256 KiB and 1 MiB in 1 KiB chunks 1 ms apart):
 *   the scripted provider streaming a reply with progress checkpoints:
 *   time to roundFinal, checkpoints sent, and bytes written to the blob
 *   directory (each checkpoint stages the whole text so far; superseded
 *   ones stay on disk until M13's collection).
 */
import '../../scripts/_init.mjs';

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, harnessRoot } = await import('../../perf/_harness.mjs');
const { makeBlobStore } =
  await import('../../resources/agent-host/impl/blobs.js');
const { makeContent } =
  await import('../../resources/agent-host/impl/content.js');
const { makeFakeBlobSink } = await import('./_m1b-blobs.js');
const { makeScriptedProvider, scriptedUnexpectedFailure } =
  await import('../../resources/agent-host/impl/providers/scripted.js');
const { makeEndpoint } =
  await import('../../resources/agent-host/impl/endpoint.js');
const { makeTimers } =
  await import('../../resources/agent-host/impl/timers.js');
const { readdirSync, statSync } = await import('node:fs');
// eslint-disable-next-line import/no-relative-packages
const { limits } = await import('../../guest/lib/limits.js');

const { E } = /** @type {any} */ (globalThis);

const SIZES = [1_048_576, 10_485_760];
const REPS = Number(process.env.BLOB_REPS ?? 5);
const FIELDS = Number(process.env.BLOB_FIELDS ?? 200);

const root = mkdtempSync(path.join(harnessRoot, 'tmp', 'bb'));
const dir = path.join(root, 'agent-host', 'blobs');
const fake = makeFakeBlobSink();
const store = makeBlobStore({ dir, sink: fake.sink });
const content = makeContent({ store });

/** @param {number} bytes @param {number} ms */
const mbps = (bytes, ms) => +(bytes / 1_048_576 / (ms / 1000)).toFixed(1);
/** @param {number[]} xs */
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

try {
  for (const size of SIZES) {
    const text = 'x'.repeat(size);
    /** @type {number[]} */
    const stage = [];
    /** @type {number[]} */
    const read = [];
    /** @type {number[]} */
    const pages = [];
    /** @type {number[]} */
    const writer = [];
    let pageCount = 0;
    for (let r = 0; r < REPS; r += 1) {
      let t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const staged = await store.stage(text);
      stage.push(performance.now() - t);

      t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const back = await store.read(staged.blob);
      read.push(performance.now() - t);
      if (back.length !== size) throw Error('read back the wrong text');

      t = performance.now();
      let offset = 0;
      let done = false;
      pageCount = 0;
      while (!done) {
        // eslint-disable-next-line no-await-in-loop
        const page = await E(content).read(
          staged.blob,
          harden({ offset, maxBytes: limits.blobPageBytes }),
        );
        offset = page.next;
        done = page.done;
        pageCount += 1;
      }
      pages.push(performance.now() - t);

      t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const w = await E(store.writers).open();
      const piece = 'y'.repeat(limits.blobPieceBytes);
      for (let at = 0; at < size; at += limits.blobPieceBytes) {
        // eslint-disable-next-line no-await-in-loop
        await E(w).append(
          at + limits.blobPieceBytes <= size
            ? piece
            : piece.slice(0, size - at),
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const closed = await E(w).close();
      writer.push(performance.now() - t);
      if (closed.bytes !== size) throw Error('writer wrote the wrong size');
    }
    const extra = { size, reps: REPS };
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.stage', stage, {
      extra: { ...extra, mbps: mbps(size, median(stage)) },
    });
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.read', read, {
      extra: { ...extra, mbps: mbps(size, median(read)) },
    });
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.readPages', pages, {
      extra: { ...extra, pages: pageCount, mbps: mbps(size, median(pages)) },
    });
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.writer', writer, {
      extra: {
        ...extra,
        pieces: Math.ceil(size / limits.blobPieceBytes),
        mbps: mbps(size, median(writer)),
      },
    });
  }

  /** @type {any[]} */
  const handles = [];
  for (const size of [9216, 32_768, 98_304]) {
    const text = 'f'.repeat(size);
    /** @type {number[]} */
    const samples = [];
    const mintsBefore = fake.counts.mints;
    for (let i = 0; i < FIELDS; i += 1) {
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const staged = await store.stage(text);
      samples.push(performance.now() - t);
      handles.push(staged.blob);
    }
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.stage.field', samples, {
      extra: {
        size,
        managerCranksPerField: +(
          (fake.counts.mints - mintsBefore) /
          FIELDS
        ).toFixed(4),
        vatDeliveriesPerField: 0,
      },
    });
  }

  const fresh = makeBlobStore({ dir, sink: fake.sink });
  const some = handles.slice(0, 1000);
  const resolvesBefore = fake.counts.resolves;
  const t = performance.now();
  await fresh.resolveMany(some);
  await stats('blobs.resolve', [performance.now() - t], {
    extra: {
      handles: some.length,
      managerCranks: fake.counts.resolves - resolvesBefore,
    },
  });

  const { Far } = /** @type {any} */ (globalThis);
  const timers = makeTimers();
  /** @param {string} where */
  const dirBytes = where =>
    readdirSync(where).reduce(
      (sum, name) => sum + statSync(path.join(where, name)).size,
      0,
    );
  for (const size of [262_144, 1_048_576]) {
    const streamDir = path.join(root, `stream-${size}`);
    const streamStore = makeBlobStore({ dir: streamDir, sink: fake.sink });
    // One chunk per KiB: the script's chunk list is built here.
    const chunks = Array.from({ length: size / 1024 }, () => ({
      text: 'c'.repeat(1024),
      delayMs: 1,
    }));
    const streaming = makeScriptedProvider({
      label: 'bench',
      script: harden({ turns: [{ rounds: [{ chunks }] }] }),
      timers,
      blobs: streamStore,
    });
    let checkpoints = 0;
    /** @type {(value: any) => void} */
    let finished = () => {};
    const final = new Promise(resolve => {
      finished = resolve;
    });
    const sink = Far('TurnSink', {
      dispatching: () => true,
      roundFinal: (/** @type {any} */ r) => finished(r),
      roundFailed: (/** @type {any} */ f) => finished(f),
      deadline: () => undefined,
      progress: () => {
        checkpoints += 1;
      },
    });
    const turn = Far('Turn', {});
    const endpoint = makeEndpoint({
      provider: streaming,
      channel: harden({ publishDelta: () => {} }),
      timers,
      unexpectedFailure: scriptedUnexpectedFailure,
    });
    const t0 = performance.now();
    void E(endpoint).holdTurn(turn);
    E.sendOnly(endpoint).startRound(
      harden({
        turn,
        sink,
        turnId: 't1',
        round: 0,
        base: { count: 0, epoch: 0 },
        append: [{ kind: 'turn-started', turnId: 't1', input: 'x', at: 1 }],
        tools: [],
        options: { modelId: 'm' },
      }),
    );
    // eslint-disable-next-line no-await-in-loop
    const result = await final;
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-await-in-loop
    await stats('blobs.stream', [ms], {
      extra: {
        size,
        chunkBytes: 1024,
        checkpoints,
        replyBytes: result.text?.bytes ?? null,
        diskBytes: dirBytes(streamDir),
        diskPerReplyByte: +(dirBytes(streamDir) / size).toFixed(2),
      },
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
