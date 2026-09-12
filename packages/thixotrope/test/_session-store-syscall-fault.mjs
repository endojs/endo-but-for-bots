// @ts-check
// Inject failure phases through the store's sync file capability.
import '@endo/init';
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeNodePowers } from '../src/platform/node-powers.js';

const platform = makeNodePowers();
const syncFiles = { ...platform.syncFiles };

const [statePath, token, phase, encodedMeta] = process.argv.slice(2);
const target = join(statePath, 'sessions', token, 'meta.json');
let injections = 0;
const fail = () => {
  injections += 1;
  throw Object.assign(Error(`injected ${phase}`), { code: 'ENOSPC' });
};
if (phase !== 'read') {
  syncFiles.writeTextAtomic = (path, text, options) => {
    if (path !== target) {
      platform.syncFiles.writeTextAtomic(path, text, options);
      return;
    }
    const temporary = `${path}.tmp`;
    if (phase === 'partial-write') {
      writeFileSync(temporary, text.slice(0, 19));
      fail();
      return;
    }
    if (phase === 'temp-fsync' || phase === 'rename') {
      writeFileSync(temporary, text);
      fail();
      return;
    }
    if (phase === 'directory-fsync') {
      // Publish first, then fail while persisting the directory entry, so a
      // restarted process observes the renamed image even though the caller
      // learned of a failure.
      const fd = openSync(temporary, 'w');
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      fail();
      return;
    }
    platform.syncFiles.writeTextAtomic(path, text, options);
  };
}

const { makeFsStore } = await import('../src/store/store-fs.js');
const session = makeFsStore(
  { syncFiles, paths: platform.paths },
  statePath,
).provideSessionStore(token);
/** @type {string | undefined} */
let errorCode;
try {
  if (phase !== 'read') session.setMeta(JSON.parse(encodedMeta));
} catch (error) {
  errorCode = /** @type {NodeJS.ErrnoException} */ (error).code;
}
process.stdout.write(
  JSON.stringify({ injections, errorCode, meta: session.getMeta() }),
);
