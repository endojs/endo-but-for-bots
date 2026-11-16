// @ts-check
// Test helpers for W1b.1 (blobs and staging): a blob store in a temporary
// directory over a fake manager sink that mints local handles and counts
// its cranks. Import after the guest prelude.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A fake `AgentHostSink` blob half: handles are local Far objects; the
 * key map is weak, as the manager's.
 * @param {{ batch?: number }} [options]
 */
export const makeFakeBlobSink = ({ batch = 32 } = {}) => {
  let serial = 0;
  /** @type {WeakMap<any, string>} */
  const keys = new WeakMap();
  const counts = { mints: 0, resolves: 0, resolved: 0 };
  const sink = Far('AgentHostSink', {
    mintBlobs: () => {
      counts.mints += 1;
      /** @type {any[]} */
      const entries = [];
      for (let i = 0; i < batch; i += 1) {
        serial += 1;
        const blob = Far('Blob', {});
        keys.set(blob, `b${serial}`);
        entries.push(harden({ blob, key: `b${serial}` }));
      }
      return harden(entries);
    },
    /** @param {any[]} blobs */
    resolveBlobs: blobs => {
      counts.resolves += 1;
      counts.resolved += blobs.length;
      return harden(blobs.map(blob => keys.get(blob) ?? null));
    },
  });
  return { sink, counts };
};

/**
 * @param {object} [options]
 * @param {any} [options.sink]
 * @param {string} [options.dir]
 * @param {Parameters<typeof makeBlobStore>[0]['trace']} [options.trace]
 */
export const makeTestBlobs = ({ sink, dir, trace } = {}) => {
  const fake = sink === undefined ? makeFakeBlobSink() : undefined;
  const root = dir ?? mkdtempSync(join(tmpdir(), 'w1b1-'));
  const store = makeBlobStore({
    dir: join(root, 'agent-host', 'blobs'),
    sink: sink ?? fake?.sink,
    trace,
  });
  return {
    store,
    root,
    blobDir: join(root, 'agent-host', 'blobs'),
    sink: sink ?? fake?.sink,
    counts: fake?.counts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};
