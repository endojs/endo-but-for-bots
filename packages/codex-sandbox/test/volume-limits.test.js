// @ts-check
import '@endo/init';
import test from 'ava';
import { normalizeCodexVolumeLimits } from '../src/volume-limits.js';

test('volume limits allow only positive MiB-aligned reductions', t => {
  const defaults = normalizeCodexVolumeLimits();
  // One quota-backed volume: the CLI's own home. The workspace is a 9P
  // projection of a tree the host already holds, so a limit for it here would
  // be a ceiling nothing enforces.
  t.deepEqual(defaults, { stateBytes: 4n * 1024n ** 3n });
  const smaller = { stateBytes: 256n * 1024n ** 2n };
  t.deepEqual(normalizeCodexVolumeLimits(smaller), smaller);
  for (const stateBytes of [0n, -1n, 1n, defaults.stateBytes + 1024n ** 2n]) {
    t.throws(() => normalizeCodexVolumeLimits({ stateBytes }), {
      message: /reductions/,
    });
  }
  for (const invalid of [
    { stateBytes: 512 },
    { stateBytes: defaults.stateBytes, additionalBytes: 1024n },
    // The workspace budget is not merely ignored: a configuration that still
    // carries one is refused, so an operator is told rather than silently
    // given a limit nothing applies.
    { stateBytes: defaults.stateBytes, workspaceBytes: 8n * 1024n ** 3n },
    {},
  ]) {
    t.throws(() => normalizeCodexVolumeLimits(/** @type {any} */ (invalid)), {
      message: /limits/,
    });
  }
});
