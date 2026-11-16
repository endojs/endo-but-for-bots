// @ts-check
/**
 * One racing taker for test/run-lock.test.js:
 *   node run-lock-taker.mjs LOCK MARKER LOG MODE
 * Takes the lock (polling every 5 ms), creates MARKER exclusively (failure
 * means two holders at once and is logged as "overlap"), holds 5-25 ms,
 * removes MARKER, then either releases (MODE "release") or exits still
 * holding the lock (MODE "die"), leaving a stale lock for the next taker.
 */
import { appendFile, open, unlink } from 'node:fs/promises';

import { acquireRunLock } from '../../scripts/run-lock.mjs';

const [lockPath, marker, log, mode] = process.argv.slice(2);
const lock = await acquireRunLock({
  lockPath,
  pollMs: 5,
  env: {},
  label: `race ${process.pid}`,
  onEvent: event =>
    void appendFile(log, `${JSON.stringify({ pid: process.pid, ...event })}\n`),
});
let handle;
try {
  handle = await open(marker, 'wx');
} catch {
  await appendFile(log, `${JSON.stringify({ pid: process.pid, overlap: true })}\n`);
}
await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 20));
if (handle) {
  await handle.close();
  await unlink(marker);
}
await appendFile(log, `${JSON.stringify({ pid: process.pid, held: mode })}\n`);
if (mode === 'release') await lock.release();
process.exit(0);
