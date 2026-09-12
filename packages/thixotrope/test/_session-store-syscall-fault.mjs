// @ts-check
// Inject syscall failures through the store platform capability.
import '@endo/init';
import { dirname, join } from 'node:path';

import { makeNodePowers } from '../src/platform/node-powers.js';

const platform = makeNodePowers();
const fs = { ...platform.fs };
const nodePowers = { ...platform, fs };

const [statePath, token, phase, encodedMeta] = process.argv.slice(2);
const target = join(statePath, 'sessions', token, 'meta.json');
const temporary = `${target}.tmp`;
const original = {
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  renameSync: fs.renameSync,
};
/** @type {Map<number, string>} */
const paths = new Map();
let injections = 0;
const fail = () => {
  injections += 1;
  throw Object.assign(Error(`injected ${phase}`), { code: 'ENOSPC' });
};
fs.openSync = (path, flags, mode) => {
  const fd = original.openSync(path, flags, mode);
  paths.set(fd, String(path));
  return fd;
};
fs.closeSync = fd => {
  paths.delete(fd);
  original.closeSync(fd);
};
fs.writeFileSync = (path, data, ...rest) => {
  if (phase === 'partial-write' && String(path) === temporary) {
    original.writeFileSync(path, String(data).slice(0, 19), ...rest);
    fail();
  }
  original.writeFileSync(path, data, ...rest);
};
fs.fsyncSync = fd => {
  if (
    (phase === 'temp-fsync' && paths.get(fd) === temporary) ||
    (phase === 'directory-fsync' && paths.get(fd) === dirname(target))
  ) {
    fail();
  }
  original.fsyncSync(fd);
};
fs.renameSync = (from, to) => {
  if (phase === 'rename' && String(to) === target) fail();
  original.renameSync(from, to);
};
const { makeFsStore } = await import('../src/store/store-fs.js');
const session = makeFsStore(nodePowers, statePath).provideSessionStore(token);
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
