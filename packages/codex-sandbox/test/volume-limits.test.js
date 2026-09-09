// @ts-check
import '@endo/init';
import test from 'ava';
import { normalizeCodexVolumeLimits } from '../src/volume-limits.js';

test('volume limits allow only positive MiB-aligned reductions', t => {
  const defaults = normalizeCodexVolumeLimits();
  t.deepEqual(defaults, {
    workspaceBytes: 8n * 1024n ** 3n,
    stateBytes: 4n * 1024n ** 3n,
  });
  const smaller = {
    workspaceBytes: 512n * 1024n ** 2n,
    stateBytes: 256n * 1024n ** 2n,
  };
  t.deepEqual(normalizeCodexVolumeLimits(smaller), smaller);
  for (const workspaceBytes of [
    0n,
    -1n,
    1n,
    defaults.workspaceBytes + 1024n ** 2n,
  ]) {
    t.throws(
      () => normalizeCodexVolumeLimits({ ...defaults, workspaceBytes }),
      { message: /reductions/ },
    );
  }
  for (const invalid of [
    { ...defaults, stateBytes: 0n },
    { ...defaults, workspaceBytes: 512 },
    { ...defaults, additionalBytes: 1024n },
    { workspaceBytes: defaults.workspaceBytes },
  ]) {
    t.throws(() => normalizeCodexVolumeLimits(/** @type {any} */ (invalid)), {
      message: /limits/,
    });
  }
});
