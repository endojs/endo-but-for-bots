// @ts-check
/**
 * Node benchmark of the blob store's relay copy (designs/m9-interfaces.md
 * section 10.1, row `mail.copy`): `BlobStore.copy` of a 1 MiB staged body,
 * plain (a hard link, rename, directory fsync) and cut to the tool limit
 * (`maxUnits = toolOutputUnits - 1280`, a suffix: a 1 MiB streamed read
 * and one written file). No vat and no supervisor, so it needs no run
 * lock; files go to a temporary directory under the harness `tmp/` (the
 * disk state directories use). Each copy is released after its sample,
 * outside the timed span, so the daemon count stays flat. Rows are JSON
 * lines through `perf/_harness.mjs` (`PERF_OUT` appends them).
 *
 *   node test/adapter/blob-copy.bench.mjs
 *
 * Environment: BLOB_COPY_WINDOW_MS (default 10,000 per row, scaled by
 * PERF_WINDOW_SCALE), BLOB_COPY_MIN (default 200 samples per row).
 */
import '../../scripts/_init.mjs';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, harnessRoot } = await import('../../perf/_harness.mjs');
const { runWindow, windowMs, windowFields } =
  await import('../../perf/_window.mjs');
const { makeBlobStore } =
  await import('../../resources/agent-host/impl/blobs.js');
const { makeFakeBlobSink } = await import('./_m1b-blobs.js');
// eslint-disable-next-line import/no-relative-packages
const { limits } = await import('../../guest/lib/limits.js');

const { Far } = /** @type {any} */ (globalThis);

const SIZE = 1_048_576;
const ms = windowMs('BLOB_COPY_WINDOW_MS', 10_000);
const min = Number(process.env.BLOB_COPY_MIN ?? 200);

mkdirSync(path.join(harnessRoot, 'tmp'), { recursive: true });
const root = mkdtempSync(path.join(harnessRoot, 'tmp', 'bc'));
const store = makeBlobStore({
  dir: path.join(root, 'agent-host', 'blobs'),
  sink: makeFakeBlobSink().sink,
});

try {
  const sender = Far('Session', {});
  const source = await store.stage('m'.repeat(SIZE), { owner: sender });
  const rows = [
    { mode: 'plain', options: {}, budget: { median: 5 } },
    {
      mode: 'cut',
      options: {
        maxUnits: limits.toolOutputUnits - 1280,
        suffix: '\n[2 attachments]',
      },
      budget: { median: 20 },
    },
  ];
  for (const { mode, options, budget } of rows) {
    // eslint-disable-next-line no-await-in-loop
    const w = await runWindow(
      async () => {
        const t = performance.now();
        const copied = await store.copy(source.blob, options);
        const took = performance.now() - t;
        await store.release([/** @type {string} */ (store.keyOf(copied.blob))]);
        return took;
      },
      { ms, min },
    );
    const { window, samples, ...rate } = windowFields(w);
    // eslint-disable-next-line no-await-in-loop
    await stats('mail.copy', w.results, {
      budget,
      window,
      samples,
      extra: { mode, sourceBytes: SIZE, ...rate },
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
