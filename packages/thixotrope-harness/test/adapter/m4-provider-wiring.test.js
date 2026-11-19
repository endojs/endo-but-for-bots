// @ts-check
// M4 W4.6: the adapter wiring (H-3 in attach.js, H-4 in index.js;
// designs/m4-interfaces.md 3.2, 15) through `makeAgentHostImpl`'s ops facet
// with a fake manager sink, a real Secrets store under H/tmp and the fake
// subscription server (127.0.0.1): the ops guard admits a PoolSpec; a pool
// open hands out `accountStatus` in its TurnPorts and the tool answers the
// pool's accounts; pool specs' catalogue calls go to the pool catalogue;
// `ops.credentials()` answers the CredentialOps facet (describe batch,
// description edit, audit reader, accounts). No supervisor.
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import { makeStoreDirs, openStore, storedCredential } from './_m4-renewal.js';

const { E, Far } = /** @type {any} */ (globalThis);

const harnessTmp = resolve(
  fileURLToPath(new URL('../../tmp/', import.meta.url)),
);

/** @param {import('ava').ExecutionContext} t */
const setup = async t => {
  const server = await startFakeSubscriptionServer({
    defaults: { 'GET /v1/models': { file: 'claude-models.json' } },
  });
  t.teardown(server.close);
  const dirs = makeStoreDirs('w46-wiring');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  await store.create('ka', 'member a', 'subscription credential');
  await store.replace(
    'ka',
    storedCredential({
      provider: 'claude',
      accessToken: ['fake', 'w46', 'wiring'].join('-'),
      expiresAtMs: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    }),
  );
  const member = Far('PoolMember', {});
  const secretHandle = Far('Secret', {});
  const backend = Far('Backend', {});
  const entry = harden({
    member,
    label: 'member a',
    provider: 'claude',
    weight: 1,
    key: 'ka',
    state: 'active',
  });
  let loads = 0;
  const sink = Far('AgentHostSink', {
    poolState: () => {
      loads += 1;
      return harden({ state: 'active', members: [entry], served: [] });
    },
    poolChanged: () => undefined,
    poolOf: () => undefined,
    resolveSecrets: (/** @type {any[]} */ handles) =>
      harden(handles.map(h => (h === secretHandle ? 'ka' : null))),
  });
  mkdirSync(harnessTmp, { recursive: true });
  const root = mkdtempSync(join(harnessTmp, 'w46-wiring-blobs-'));
  t.teardown(() => rmSync(root, { recursive: true, force: true }));
  const impl = makeAgentHostImpl({
    sink,
    blobDir: join(root, 'state', 'agent-host', 'blobs'),
    secrets: /** @type {any} */ ({
      readKey: async () => {
        throw Error('no API key here');
      },
      credentialFor: (/** @type {string} */ key) =>
        makeCredentialAccess({ store, key }),
      store,
    }),
  });
  const spec = harden({
    kind: 'claude-pool',
    label: 'claude pool',
    members: [member],
    modelId: 'claude-sonnet-5',
    baseUrl: server.url,
    usageUrl: `${server.url}/api/oauth/usage`,
  });
  return {
    server,
    store,
    impl,
    backend,
    spec,
    secretHandle,
    loads: () => loads,
  };
};

test('a pool open passes the ops guard and offers accountStatus, which answers the pool accounts', async t => {
  const s = await setup(t);
  const session = Far('Session', {
    getUsage: () =>
      harden({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 }),
  });
  const ports = s.impl.ops.open(
    harden({ backend: s.backend, spec: s.spec, session }),
  );
  t.deepEqual(
    ports.tools.map((/** @type {any} */ e) => e.name),
    // M8 (S-18): every kind's ports also carry viewImage.
    ['accountStatus', 'viewImage'],
  );
  t.is(s.loads(), 0, 'dormant: nothing loaded at open');
  const outcome = await E(ports.tools[0].tool).execute(
    harden({ opId: 'op1', args: '{}' }),
  );
  t.is(outcome.status, 'ok');
  t.true(outcome.text.includes('member a'), outcome.text);
  t.false(outcome.text.includes(subscriptionTexts.noSubscriptionAccounts));
  t.is(s.loads(), 1, 'one poolState load for the accounts');
});

test('pool specs route listModels and resolveModel to the pool catalogue', async t => {
  const s = await setup(t);
  const page = await s.impl.ops.listModels(
    harden({ backend: s.backend, spec: s.spec }),
  );
  t.is(page.state, 'ok');
  t.true(
    page.rows.some(
      (/** @type {any} */ row) =>
        row.selectionId === 'claude pool:claude-sonnet-5',
    ),
  );
  const resolved = await s.impl.ops.resolveModel(
    harden({ backend: s.backend, spec: s.spec, modelId: 'claude-sonnet-5' }),
  );
  t.deepEqual(resolved, {
    modelId: 'claude-sonnet-5',
    contextLength: 200_000,
    maxOutputTokens: 16_384,
  });
  const gets = s.server.requests().filter(r => r.method === 'GET');
  t.is(gets.length, 1, 'the second call is served from the cache');
});

test('ops.credentials() answers CredentialOps: describe batch, description, audit reader, accounts', async t => {
  const s = await setup(t);
  const ops = s.impl.ops.credentials();
  t.is(ops, s.impl.ops.credentials(), 'one facet per incarnation');
  /** @type {any[]} */
  const described = await E(ops).describeSecrets(harden(['ka', 'kz']));
  t.is(described.length, 2);
  t.is(described[0].key, 'ka');
  t.is(described[0].state, 'active');
  t.true(Number(described[0].bytes) > 0);
  t.is(described[1], null);
  t.false(JSON.stringify(described).includes('fake-w46'), 'never a value');
  await E(ops).setSecretDescription('ka', 'the first member');
  t.is((await s.store.describe('ka')).description, 'the first member');
  const reader = await E(ops).auditReader();
  /** @type {{ events: any[] }} */
  const page = await E(reader).page(harden({ secret: s.secretHandle }));
  t.true(page.events.length > 0);
  t.true(page.events.every((/** @type {any} */ e) => e.label === 'member a'));
  const accounts = await E(ops).accounts();
  const view = await E(accounts).list();
  t.deepEqual(view.pools, []);
});
