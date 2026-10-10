// @ts-check
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIronhorseEngine } from '../src/ironhorse-engine.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';

/** @param {Uint8Array} bytes */
export const isIncrement = bytes => {
  const reader = syrupCodec.makeReader(bytes);
  reader.enterRecord();
  if (reader.readSelectorAsString() !== 'op:deliver') return false;
  reader.enterRecord();
  reader.readSelectorAsString();
  reader.readInteger();
  reader.exitRecord();
  reader.enterList();
  return reader.readSelectorAsString() === 'incr';
};
harden(isIncrement);

/** @param {'replay' | 'ironhorse'} kind @param {string} statePath */
export const makeProcessTestEngine = (kind, statePath) =>
  kind === 'replay'
    ? makePeerJournalReplayEngine()
    : makeIronhorseEngine({
        workerBinary:
          process.env.THIXOTROPE_IRONHORSE_WORKER ??
          fileURLToPath(
            new URL(
              '../../../target/release/thixotrope-ironhorse-worker',
              import.meta.url,
            ),
          ),
        bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
          fileURLToPath(new URL(`../dist-ironhorse/${name}`, import.meta.url)),
        ),
        storePath: join(statePath, 'heaps'),
      });
harden(makeProcessTestEngine);
