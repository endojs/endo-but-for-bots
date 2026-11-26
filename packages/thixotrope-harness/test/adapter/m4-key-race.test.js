// @ts-check
// M4 W4.8: the Secrets wrapping key's first creation is atomic. The store
// and the sealing keys load it at once on the first `openWriter()`; the
// loser used to read the winner's still-empty file ("must hold exactly 32
// bytes", found by m4-secrets.test.js through the daemon).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSealKeys } from '../../resources/agent-host/impl/secrets/seal.js';
import { makeSecretStore } from '../../resources/agent-host/impl/secrets/store.js';
import {
  loadWrappingKey,
  makeWrappingKey,
} from '../../resources/agent-host/impl/secrets/wrapping-key.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('concurrent first loads of the key file all answer the same 32-byte key', async t => {
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'w48-key-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  for (let round = 0; round < 20; round += 1) {
    const keyFile = join(dir, `k${round}`, 'secrets.key');
    // eslint-disable-next-line no-await-in-loop
    const keys = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadWrappingKey({ keyFile, stateDir: join(dir, `s${round}`) }),
      ),
    );
    t.true(keys.every(key => key.length === 32));
    t.true(keys.every(key => key.equals(keys[0])));
    t.deepEqual(readdirSync(join(dir, `k${round}`)), ['secrets.key']);
  }
});

test('a failed key load is not kept: the next get, and the store and sealing keys over it, load again (HR-SYN-5)', async t => {
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'key-retry-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'keys', 'secrets.key');
  mkdirSync(join(dir, 'keys'));
  writeFileSync(keyFile, Buffer.alloc(32, 7));
  chmodSync(keyFile, 0o644);
  const wrappingKey = makeWrappingKey({ keyFile });
  const store = makeSecretStore({
    file: join(dir, 'state', 'agent-host', 'secrets.enc'),
    wrappingKey,
  });
  t.teardown(() => store.close());
  const seal = makeSealKeys({ wrappingKey });
  await t.throwsAsync(wrappingKey.get(), { message: /group or others/ });
  await t.throwsAsync(store.ready(), { message: /group or others/ });
  await t.throwsAsync(seal.ready(), { message: /group or others/ });
  chmodSync(keyFile, 0o600);
  t.true((await wrappingKey.get()).equals(Buffer.alloc(32, 7)));
  await store.ready();
  await seal.ready();
  t.regex(seal.publicKey(), /^[0-9a-f]{64}$/);
  // Kept once loaded: the file going away does not matter to this incarnation.
  rmSync(keyFile);
  t.true((await wrappingKey.get()).equals(Buffer.alloc(32, 7)));
});
