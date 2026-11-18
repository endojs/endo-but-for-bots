// @ts-check
/**
 * The agent host's ops facet guard for the Secrets methods, with the real
 * secrets ops behind it (W2.9). W2.3's tests drove a fake ops facet without
 * the guard, so the bigint `M.nat()` guards of `secretDescribe` and
 * `secretAudit` refused every number the store answers; m2-secrets found it
 * in a daemon.
 */
import '../unit/_m1a-prelude.js';
import test from '@endo/ses-ava/test.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E } from '@endo/far';

import { makeOps } from '../../resources/agent-host/impl/attach.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { makeSealKeys } from '../../resources/agent-host/impl/secrets/seal.js';
import { makeSecretStore } from '../../resources/agent-host/impl/secrets/store.js';

test('secretDescribe and secretAudit answer through the ops guard', async t => {
  const base = mkdtempSync(join(tmpdir(), 'w29-ops-'));
  t.teardown(() => rmSync(base, { recursive: true, force: true }));
  const stateDir = join(base, 'state');
  const keyFile = join(base, 'secrets.key');
  const store = makeSecretStore({
    file: join(stateDir, 'agent-host', 'secrets.enc'),
    keyFile,
    stateDir,
  });
  const secrets = makeSecretsOps({
    store,
    seal: makeSealKeys({ file: keyFile, stateDir }),
    sink: () => {
      throw Error('no sink in this test');
    },
  });
  const unused = () => {
    throw Error('unused');
  };
  const ops = makeOps({
    open: unused,
    liveChannel: unused,
    live: unused,
    composer: unused,
    content: unused,
    secretCreate: secrets.secretCreate,
    secretDescribe: secrets.secretDescribe,
    secretRevoke: secrets.secretRevoke,
    secretDelete: secrets.secretDelete,
    secretAudit: secrets.secretAudit,
    secretWriter: secrets.secretWriter,
  });
  await E(ops).secretCreate(
    harden({ key: 'k1', label: 'a key', description: 'test' }),
  );
  const info = await E(ops).secretDescribe('k1');
  t.is(typeof info.generation, 'number');
  t.is(info.state, 'active');
  const audit = await E(ops).secretAudit(harden({ key: 'k1', limit: 10 }));
  t.true(Array.isArray(audit));
});
