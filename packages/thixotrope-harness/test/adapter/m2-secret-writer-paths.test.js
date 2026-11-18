// @ts-check
// The two secret write paths (m2-interfaces.md 9.2; m3-interfaces.md A-11;
// the open M2 major of M2-R1 (b), J-9486): the remotable `SecretWriter`
// (reachable through the hub) takes a `SealedBox` only, and its guard
// refuses a plain value before the method runs; a page writes a plain value
// through the gateway's in-process writer (`GatewayPowers.extras`, label
// `secretWriterLabel`), which calls `replaceLocal` and is not a method of
// any remotable. Here the gateway is the real service (`GW/index.js`) on a
// loopback port with a real secrets store under H/tmp, and the page is a
// Node CapTP client over a real WebSocket. The manager vat is a stand-in
// sink that maps one Secret presence to its key.
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  makeGatewayService,
  notAttachedText,
} from '../../resources/agent-host/impl/gateway/index.js';
import { secretWriterLabel } from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeSignInStore } from '../../resources/agent-host/impl/gateway/signin.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import {
  makeSealKeys,
  sealTo,
} from '../../resources/agent-host/impl/secrets/seal.js';
import { SECRETS_KEY_VARIABLE } from '../../resources/agent-host/impl/secrets/store.js';
import { connectGateway } from '../integration/_m3-gateway.js';
import { makeStoreDirs, openStore } from './_m4-renewal.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A value no store or log may show; built at run time.
 * @param {string} tag
 */
const valueOf = tag =>
  ['not', 'a', 'real', 'secret', tag, String(process.pid)].join('-');

/**
 * Secrets ops over a fresh store, with a stand-in sink that knows one
 * Secret (`k1`).
 * @param {string} tag
 */
const makeWorld = async tag => {
  const dirs = makeStoreDirs(tag);
  const store = openStore(dirs.files);
  await store.create('k1', 'provider key', 'the one secret');
  const secret = Far('Secret', {});
  const sink = Far('AgentHostSink', {
    /** @param {any[]} handles */
    resolveSecrets: handles =>
      harden(handles.map(handle => (handle === secret ? 'k1' : null))),
  });
  const ops = makeSecretsOps({
    store,
    seal: makeSealKeys({
      file: dirs.files.keyFile,
      stateDir: dirs.files.stateDir,
    }),
    sink,
  });
  return { dirs, store, secret, ops };
};

test('the remotable SecretWriter refuses a plain value at its guard; a sealed box is written', async t => {
  const { dirs, store, secret, ops } = await makeWorld('xa-sealed');
  t.teardown(() => {
    store.close();
    dirs.done();
  });
  const writer = await ops.secretWriter();
  const plain = valueOf('plain');
  const error = await t.throwsAsync(() => E(writer).replace(secret, plain));
  t.regex(String(error?.message), /SecretWriter.*arg 1.*Must be a copyRecord/);
  t.is((await store.describe('k1')).generation, 0, 'nothing written');
  t.deepEqual(
    (await store.audit({ key: 'k1', limit: 10 })).map(e => e.op),
    ['create', 'create'],
    'the refusal never reached the store',
  );
  const publicKey = await E(writer).publicKey();
  const sealed = valueOf('sealed');
  t.deepEqual(await E(writer).replace(secret, sealTo(publicKey, sealed)), {
    generation: 1,
  });
  t.is((await store.read('k1')).value, sealed);
  // The in-process path is not a method of the remotable.
  t.false('replaceLocal' in writer);
  await t.throwsAsync(() => E(writer).replaceLocal(secret, plain), {
    message: /replaceLocal/,
  });
});

test('replaceLocal writes a plain value or a box, with the generation check', async t => {
  const { dirs, store, secret, ops } = await makeWorld('xa-local');
  t.teardown(() => {
    store.close();
    dirs.done();
  });
  const first = valueOf('first');
  t.deepEqual(await ops.replaceLocal(secret, first, 0), { generation: 1 });
  t.is((await store.read('k1')).value, first);
  await t.throwsAsync(() => ops.replaceLocal(secret, valueOf('stale'), 0), {
    message: textOf.secretFailed('GENERATION_CONFLICT'),
  });
  const publicKey = await ops.publicKeyLocal();
  t.is(publicKey, await E(await ops.secretWriter()).publicKey());
  const boxed = valueOf('boxed');
  t.deepEqual(await ops.replaceLocal(secret, sealTo(publicKey, boxed), 1), {
    generation: 2,
  });
  t.is((await store.read('k1')).value, boxed);
  await t.throwsAsync(() => ops.replaceLocal(Far('Secret', {}), valueOf('x')), {
    message: textOf.secretFailed('UNKNOWN_SECRET'),
  });
});

test('a page writes a plain value through the gateway in process; never through the hub writer', async t => {
  const { dirs, store, secret, ops } = await makeWorld('xa-gateway');
  const stateDir = mkdtempSync(join(dirs.root, 'gw-'));
  mkdirSync(join(stateDir, 'agent-host'), { recursive: true });
  const env = { [SECRETS_KEY_VARIABLE]: dirs.files.keyFile };
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  const hubWriter = await ops.secretWriter();
  // The operator's SecretsAdmin stand-in offers the Secret, and the hub's
  // writer as `SecretsAdmin.openWriter()` does (a vat presence in the
  // daemon). Contract method names only: the gateway refuses others.
  const admin = Far('SecretsAdmin', {
    create: () => secret,
    openWriter: () => hubWriter,
  });
  const operator = Far('Operator', { getSecrets: () => admin });
  const service = makeGatewayService({
    live: Far('Live', {}),
    composer: Far('Composer', {}),
    content: Far('Content', {}),
    history: () => Far('History', {}),
    secretWriter: async () =>
      harden({ replaceLocal: ops.replaceLocal, publicKey: ops.publicKeyLocal }),
    stateDir,
    env,
    log: event => logged.push(event),
  });
  t.teardown(async () => {
    await service.close();
    store.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });
  await service.binding.bind(
    harden({
      config: { port: 0, operator },
      sink: Far('GatewaySink', { attach: () => undefined }),
    }),
  );
  const port = /** @type {number} */ (service.port());
  const fragment = await makeSignInStore({ stateDir, env }).fragment('h');
  const secretHex = new URLSearchParams(fragment.slice(1)).get('agent') ?? '';
  const page = await connectGateway({
    port,
    origin: `http://127.0.0.1:${port}`,
    secret: secretHex,
  });
  t.teardown(() => page.close());
  const powers = await page.signIn();
  const found = powers.extras.find(
    (/** @type {any} */ extra) => extra.label === secretWriterLabel,
  );
  t.truthy(found, 'the page finds the writer in its extras');
  const writer = found.service;
  const pageAdmin = await E(powers.operator).getSecrets();
  const pageSecret = await E(pageAdmin).create(
    harden({ label: 'provider key', description: 'stand-in' }),
  );
  const value = valueOf('page');

  // Before the attach the writer refuses.
  await t.throwsAsync(() => E(writer).replace(pageSecret, value), {
    message: notAttachedText,
  });
  service.attached();

  t.deepEqual(await E(writer).replace(pageSecret, value, 0), {
    generation: 1,
  });
  t.is((await store.read('k1')).value, value, 'the store has the page value');
  t.regex(await E(writer).publicKey(), /^[0-9a-f]{64}$/);

  // The hub's writer, as a page would reach it through openWriter():
  // refused at its guard (the gateway forwards the call unchanged).
  const viaHub = await E(pageAdmin).openWriter();
  await t.throwsAsync(() => E(viaHub).replace(pageSecret, valueOf('hub')), {
    message: /Must be a copyRecord/,
  });
  t.is((await store.describe('k1')).generation, 1);

  // A value over the frame bound still passes (the m4-secrets LargeCall):
  // the extension's target is this very object.
  const large = 'L'.repeat(200 * 1024);
  t.deepEqual(await E(writer).replace(pageSecret, large, 1), {
    generation: 2,
  });

  // No log line carries a value.
  const text = JSON.stringify(logged);
  t.false(text.includes(value));
  t.false(text.includes(large.slice(0, 64)));
});
