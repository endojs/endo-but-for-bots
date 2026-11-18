// @ts-check
// M4 W4.8: the Secrets wrapping key's first creation is atomic. The store
// and the sealing keys load it at once on the first `openWriter()`; the
// loser used to read the winner's still-empty file ("must hold exactly 32
// bytes", found by m4-secrets.test.js through the daemon).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWrappingKey } from '../../resources/agent-host/impl/secrets/store.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('concurrent first loads of the key file all answer the same 32-byte key', async t => {
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'w48-key-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  for (let round = 0; round < 20; round += 1) {
    const keyFile = join(dir, `k${round}`, 'secrets.key');
    // eslint-disable-next-line no-await-in-loop
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => loadWrappingKey({ keyFile })),
    );
    t.true(keys.every(key => key.length === 32));
    t.true(keys.every(key => key.equals(keys[0])));
    t.deepEqual(readdirSync(join(dir, `k${round}`)), ['secrets.key']);
  }
});
