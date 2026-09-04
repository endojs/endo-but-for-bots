// @ts-check

// The package is split by lifetime: the main entry must stay loadable where
// host builtins do not resolve — the XS daemon bundle, a SES compartment — and
// only `tools.js` may reach for the filesystem. That split is the reason this
// package exists, so walk each entry's static module graph and hold it.

import test from 'ava';

import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]);

const specifierPattern =
  /(?:^|[\s;}])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

/**
 * Collect the names of every builtin module reachable by static import from an
 * entry point.
 *
 * @param {URL} entry
 * @returns {Set<string>}
 */
const builtinsReachableFrom = entry => {
  /** @type {Set<string>} */
  const found = new Set();
  const visited = new Set([entry.href]);
  const queue = [entry];
  while (queue.length > 0) {
    const url = /** @type {URL} */ (queue.pop());
    const source = readFileSync(url, 'utf-8');
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2];
      if (builtins.has(specifier)) {
        found.add(specifier);
        continue; // eslint-disable-line no-continue
      }
      const resolved = specifier.startsWith('.')
        ? new URL(specifier, url)
        : pathToFileURL(createRequire(url).resolve(specifier));
      if (!visited.has(resolved.href)) {
        visited.add(resolved.href);
        queue.push(resolved);
      }
    }
  }
  return found;
};

test('the main entry reaches no host builtin', t => {
  const reachable = builtinsReachableFrom(
    new URL('../index.js', import.meta.url),
  );
  t.deepEqual([...reachable], []);
});

test('the tools entry is where the filesystem lives', t => {
  const reachable = builtinsReachableFrom(
    new URL('../tools.js', import.meta.url),
  );
  t.true(reachable.has('node:fs'));
  t.true(reachable.has('node:fs/promises'));
});
