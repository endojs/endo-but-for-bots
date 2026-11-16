// @ts-check
/**
 * For test/serve.test.js: a stand-in for the supervisor child. Watches its
 * parent through fd 3 with scripts/serve.mjs `watchParent`, logs "gone" to
 * LOG and exits when the parent dies; otherwise it would run for ever.
 *   node parent-pipe-child.mjs LOG
 */
import { appendFileSync } from 'node:fs';

import { watchParent } from '../../scripts/serve.mjs';

const log = process.argv[2];
watchParent(3, () => {
  appendFileSync(log, `gone ${process.pid}\n`);
  process.exit(0);
});
setInterval(() => {}, 60_000);
process.stdout.write('watching\n');
