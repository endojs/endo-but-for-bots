import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

import './ses-shims.js';

const [subject, lockdownFlag, ...includes] = process.argv.slice(2);

for (const include of includes) {
  const contents = readFileSync(include, 'utf8');
  // Indirect eval evaluates test262 harness includes (sta.js, assert.js, …)
  // in the global scope, exactly as a test262 runner must.
  // eslint-disable-next-line no-eval
  (0, eval)(contents);
}

if (lockdownFlag === 'lockdown') {
  lockdown();
}

globalThis.print = (...args) => console.log(...args);

await import(pathToFileURL(subject).href);
