// @ts-check
// Kill child of blob-copy.test.js (m9-interfaces.md KM12): one adapter
// incarnation stages a source text, then makes one relay copy and SIGKILLs
// itself at a named step of the copy (a real SIGKILL: nothing after it
// runs, no finally blocks). Before the copy it writes one JSON line to
// stdout with the source's key; at the kill step it writes the copy's key.
//
//   node _blob-copy-kill-child.mjs <blobDir> <plain|cut> <killAt>
import '@endo/init';

import { writeSync } from 'node:fs';
import { argv, kill, pid } from 'node:process';

import { installGuestPrelude } from '../../scripts/guest-prelude.js';

installGuestPrelude();

const { makeBlobStore } =
  await import('../../resources/agent-host/impl/blobs.js');
const { makeFakeBlobSink } = await import('./_m1b-blobs.js');

const [blobDir, mode, killAt] = argv.slice(2);
/** @param {object} line */
const say = line => writeSync(1, `${JSON.stringify(line)}\n`);

let armed = false;
const store = makeBlobStore({
  dir: blobDir,
  sink: makeFakeBlobSink().sink,
  trace: (step, key) => {
    if (armed && step === killAt) {
      say({ copy: key });
      kill(pid, 'SIGKILL');
    }
  },
});
const source = await store.stage('relay '.repeat(4000));
say({ source: store.keyOf(source.blob) });
armed = true;
const copied = await store.copy(
  source.blob,
  mode === 'cut' ? { maxUnits: 10_000, suffix: '\n[note]' } : {},
);
say({ copy: store.keyOf(copied.blob) });
if (killAt === 'after') kill(pid, 'SIGKILL');
