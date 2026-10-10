// @ts-check
// Isolate Node built-in mutation from the SES test runner and all other tests.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

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
fs.openSync = (...args) => {
  const fd = original.openSync(...args);
  paths.set(fd, String(args[0]));
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
syncBuiltinESMExports();
await import('@endo/init');
const { makeFsStore } = await import('../src/store-fs.js');
const session = makeFsStore(statePath).provideSessionStore(token);
/** @type {string | undefined} */
let errorCode;
try {
  if (phase !== 'read') session.setMeta(JSON.parse(encodedMeta));
} catch (error) {
  errorCode = /** @type {NodeJS.ErrnoException} */ (error).code;
} finally {
  Object.assign(fs, original);
  syncBuiltinESMExports();
}
process.stdout.write(
  JSON.stringify({ injections, errorCode, meta: session.getMeta() }),
);
