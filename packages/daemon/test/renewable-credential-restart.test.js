// @ts-check
import '@endo/init/debug.js';

import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { makeEndoClient, restart, start, stop } from '../index.js';

// Test the production provisioning seam without adding a daemon dependency on
// a hosted backend package. No inference or provider credentials are used.
/* eslint-disable import/no-relative-packages */
import {
  provideManagedRenewableCredentials,
  readManagedRenewableCredentials,
} from '../../hosted-agent/src/managed-renewable-credentials.js';
/* eslint-enable import/no-relative-packages */

const testNode = process.env.ENDO_BIN ? test.serial.skip : test.serial;
/** @param {string} text */
const encode = text => encodeBase64(new TextEncoder().encode(text));

testNode(
  'renewable credentials retain exact Secret identity across rebinding and restart',
  async t => {
    t.timeout(120_000);
    const base = await mkdtemp(join(tmpdir(), 'renew-'));
    const config = {
      statePath: join(base, 'state'),
      ephemeralStatePath: join(base, 'run'),
      cachePath: join(base, 'cache'),
      sockPath: join(base, 'endo.sock'),
      address: '127.0.0.1:0',
      gcEnabled: true,
    };
    /** @type {Array<(reason: Error) => void>} */
    const connections = [];
    t.teardown(async () => {
      await stop(config);
      for (const cancel of connections) cancel(Error('test teardown'));
      await rm(base, { recursive: true, force: true });
    });
    const connect = async () => {
      const { promise: cancelled, reject: cancel } = makePromiseKit();
      cancelled.catch(() => {});
      connections.push(cancel);
      const client = await makeEndoClient(
        'renew-test',
        config.sockPath,
        cancelled,
      );
      client.closed.catch(() => {});
      return /** @type {any} */ (E(client.getBootstrap()).host());
    };
    await start(config);
    let host = await connect();
    const importer = await E(host).lookup(['@secrets', 'create']);
    await E(importer).createBase64(
      'renew-old',
      'Original inert fixture',
      encode('old'),
    );
    await E(importer).createBase64(
      'renew-new',
      'Replacement inert fixture',
      encode('new'),
    );
    const original = await E(host).lookup(['secrets', 'renew-old']);
    const replacement = await E(host).lookup(['secrets', 'renew-new']);
    const originalId = await E(host).identify('secrets', 'renew-old');
    const specification = harden({
      namePath: ['renew-wrapper'],
      secretPath: ['secrets', 'renew-old'],
      label: 'Test',
    });
    t.deepEqual(await provideManagedRenewableCredentials(host, specification), {
      minted: true,
    });
    t.deepEqual(await provideManagedRenewableCredentials(host, specification), {
      minted: false,
    });
    const retained = await readManagedRenewableCredentials(host, specification);
    t.is(retained.secret, original);
    t.false(
      (await E(host).list()).some(name =>
        name.startsWith('renewable-credential-powers.'),
      ),
    );
    await E(host).copy(['secrets', 'renew-new'], ['secrets', 'renew-old']);
    await t.throwsAsync(
      () => provideManagedRenewableCredentials(host, specification),
      { message: /secret identity changed/ },
    );
    const wrapper = await E(host).lookup('renew-wrapper');
    t.is(await E(wrapper).readBase64(), encode('old'));
    await E(wrapper).replaceBase64(encode('old-updated'), { ifGeneration: 1n });
    t.is(await E(original).readBase64(), encode('old-updated'));
    t.is(await E(replacement).readBase64(), encode('new'));
    const catalog = await E(host).lookup(['@secrets', 'catalog']);
    await t.throwsAsync(() => E(catalog).adminFor(Far('UnknownBlob', {})), {
      message: /UNKNOWN_GRANT/,
    });
    await t.throwsAsync(
      () =>
        E(catalog).adminFor(
          Far('WrappedBlob', {
            readBase64: () => E(original).readBase64(),
          }),
        ),
      { message: /UNKNOWN_GRANT/ },
    );
    await E(host).remove('secrets', 'renew-old');
    await restart(config);
    host = await connect();
    t.false(await E(host).has('secrets', 'renew-old'));
    const revived = await E(host).lookup('renew-wrapper');
    t.is(await E(revived).readBase64(), encode('old-updated'));
    await E(revived).replaceBase64(encode('old-after-restart'), {
      ifGeneration: 2n,
    });
    t.is(await E(revived).readBase64(), encode('old-after-restart'));
    const survivingOriginal = await E(host).lookupById(originalId);
    t.is(await E(survivingOriginal).readBase64(), encode('old-after-restart'));
    const revivedBinding = await readManagedRenewableCredentials(
      host,
      specification,
    );
    t.is(revivedBinding.identifier, retained.identifier);
    t.is(revivedBinding.secret, survivingOriginal);
    const survivingReplacement = await E(host).lookup(['secrets', 'renew-new']);
    t.is(await E(survivingReplacement).readBase64(), encode('new'));
    // Restore only the original alias to test restart adoption. This is not
    // permission to substitute the replacement record under the old wrapper.
    await E(host).storeIdentifier(['secrets', 'renew-old'], originalId);
    t.deepEqual(await provideManagedRenewableCredentials(host, specification), {
      minted: false,
    });
    t.is(
      (await readManagedRenewableCredentials(host, specification)).secret,
      survivingOriginal,
    );

    const currentImporter = await E(host).lookup(['@secrets', 'create']);
    await E(currentImporter).createBase64(
      'dynamic-first',
      'Dynamic first',
      encode('first'),
    );
    await E(currentImporter).createBase64(
      'dynamic-second',
      'Dynamic second',
      encode('second'),
    );
    const diagnostics = await E(host).diagnostics();
    const firstId = await E(host).identify('secrets', 'dynamic-first');
    const firstFormula = await E(diagnostics).getFormula(firstId);
    const secondFormula = await E(diagnostics).getFormula(
      await E(host).identify('secrets', 'dynamic-second'),
    );
    const firstGrant = firstFormula.properties.path.value[2];
    const secondGrant = secondFormula.properties.path.value[2];
    await E(host).storeValue(firstGrant, 'selected-secret-grant');
    // Discard import's eager canonical mappings before evaluating the dynamic
    // recipe, so this actually exercises first registration after cold start.
    await restart(config);
    host = await connect();
    await E(host).makeUnconfined(
      '@main',
      new URL('./_renewable-selected-secret.js', import.meta.url).href,
      {
        powersName: '@agent',
        resultName: 'dynamic-secret',
      },
    );
    const dynamicSpec = harden({
      namePath: ['dynamic-wrapper'],
      secretPath: ['dynamic-secret'],
      label: 'Test',
    });
    await t.throwsAsync(provideManagedRenewableCredentials(host, dynamicSpec), {
      message: /static Secret grant recipes/,
    });
    t.false(await E(host).has('dynamic-wrapper'));
    t.false(
      (await E(host).list()).some(name =>
        name.startsWith('renewable-credential-powers.'),
      ),
    );
    await E(host).storeValue(secondGrant, 'selected-secret-grant');
    await restart(config);
    host = await connect();
    t.false(await E(host).has('dynamic-wrapper'));
    t.is(
      await E(await E(host).lookup('dynamic-secret')).readBase64(),
      encode('second'),
      'the dynamic recipe itself follows the changed selector',
    );
  },
);
