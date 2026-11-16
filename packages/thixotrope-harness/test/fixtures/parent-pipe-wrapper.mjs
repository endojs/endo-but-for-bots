// @ts-check
/**
 * For test/serve.test.js: a stand-in for the serve CLI. Spawns
 * parent-pipe-child.mjs with the parent pipe on fd 3, exactly as
 * scripts/serve.mjs spawnSupervisorChild lays out stdio, prints the child's
 * pid and then waits until it is killed.
 *   node parent-pipe-wrapper.mjs LOG
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [path.join(here, 'parent-pipe-child.mjs'), process.argv[2]],
  { stdio: ['ignore', 'pipe', 'inherit', 'pipe'] },
);
child.stdout?.once('data', bytes => {
  process.stdout.write(`${child.pid} ${String(bytes).trim()}\n`);
});
setInterval(() => {}, 60_000);
