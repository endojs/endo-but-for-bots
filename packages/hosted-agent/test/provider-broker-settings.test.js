// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerKit,
  makeProviderBrokerServiceKit,
} from '../src/provider-broker-service.js';

const digest = `sha256:${'a'.repeat(64)}`;

/**
 * A broker service kit over a recording runtime owner: what the service's
 * `configure` reaches, and what the admission trail is told.
 * @param {{ publicInternet?: boolean }} [options]
 */
const fixture = ({ publicInternet = false } = {}) => {
  /** @type {Array<Record<string, unknown>>} */
  const configured = [];
  /** @type {Array<Record<string, unknown>>} */
  const settings = [];
  const kit = makeProviderBrokerServiceKit({
    label: 'Settings fixture',
    policy: /** @type {any} */ ({}),
    accountRef: 'account',
    secret: Far('secret', { readBase64: async () => '' }),
    admits: async () => true,
    ownerId: 'settings-fixture',
    directory: '/tmp/settings-fixture-never-opened',
    imageRef: `localhost/fixture@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/fixture@${digest}`,
    publicInternet,
    onSettings: next => settings.push(next),
    runtimeKit: /** @type {any} */ ({
      open: async () => harden({}),
      close: async () => {},
      configure: async next => {
        configured.push(next);
      },
    }),
  });
  return { kit, configured, settings };
};

test('configure reaches the runtime and the admission trail through the service', async t => {
  const f = fixture();
  t.teardown(f.kit.close);
  await E(f.kit.service).configure({
    maxSessions: 16,
    publicInternet: false,
    diagnostics: true,
  });
  t.deepEqual(f.configured, [{ maxListeners: 16, publicInternet: false }]);
  t.deepEqual(f.settings, [
    { maxSessions: 16, publicInternet: false, diagnostics: true },
  ]);
  // A capacity the service shape refuses never reaches the runtime.
  await t.throwsAsync(() => E(f.kit.service).configure({ maxSessions: 0 }));
  await t.throwsAsync(() =>
    E(f.kit.service).configure(/** @type {any} */ ({ imageRef: 'other' })),
  );
  t.is(f.configured.length, 1);
});

test('public admission follows configure, and is refused before live listeners stop', async t => {
  /** @type {any} */
  let issuerOptions;
  /** @type {boolean[]} */
  const allowedWhileStopping = [];
  /** @type {Array<Record<string, unknown>>} */
  const configured = [];
  const broker = makeProviderBrokerKit({
    label: 'Settings fixture',
    policy: /** @type {any} */ ({}),
    accountRef: 'account',
    secret: Far('secret', { readBase64: async () => '' }),
    admits: async () => true,
    ownerId: 'settings-fixture',
    directory: '/tmp/settings-fixture-never-opened',
    imageRef: `localhost/fixture@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/fixture@${digest}`,
    publicInternet: false,
    runtimeKit: /** @type {any} */ ({
      open: async () => harden({}),
      close: async () => {},
      configure: async next => {
        configured.push(next);
        // What the issuer would admit while live public listeners stop.
        allowedWhileStopping.push(issuerOptions.allowsPublicNetwork());
        if (next.maxListeners === 0) throw Error('Invalid listener capacity');
      },
    }),
    makeIssuer: /** @type {any} */ (
      options => {
        issuerOptions = options;
        return harden({ dispose: async () => {} });
      }
    ),
  });
  t.teardown(broker.close);
  await broker.start();
  t.is(typeof issuerOptions.makePublicNetwork, 'function');
  t.false(issuerOptions.allowsPublicNetwork());
  await broker.configure({ publicInternet: true });
  t.true(issuerOptions.allowsPublicNetwork());
  await broker.configure({ publicInternet: false });
  t.false(issuerOptions.allowsPublicNetwork());
  // Allowed only after the runtime accepted it; refused before it stopped
  // anything.
  t.deepEqual(allowedWhileStopping, [false, false]);
  // A refused capacity leaves public egress off and reaches no runtime.
  await t.throwsAsync(
    () => broker.configure({ maxSessions: 0, publicInternet: true }),
    { message: /Invalid listener capacity/ },
  );
  t.false(issuerOptions.allowsPublicNetwork());
  t.deepEqual(configured, [
    { publicInternet: true },
    { publicInternet: false },
  ]);
});

test('a revived broker takes the last configured settings, not the minted ones', async t => {
  const secret = () => Far('secret', { readBase64: async () => '' });
  const directory = await mkdtemp(join(tmpdir(), 'broker-settings-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  /** @type {Array<Array<Record<string, unknown>>>} */
  const incarnations = [];
  const make = makeOwnedProviderBrokerService({
    label: 'Settings fixture',
    log: () => {},
    readConfig: () =>
      /** @type {any} */ ({
        ownerId: 'settings-revival',
        directory,
        imageRef: `localhost/fixture@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/fixture@${digest}`,
        // Minted open and small; the operator later closed it and grew it.
        publicInternet: true,
        maxSessions: 2,
      }),
    makePolicy: () =>
      /** @type {any} */ ({ policy: {}, accountAuthority: 'fixture' }),
    makeServiceKit: /** @type {any} */ (
      options => {
        /** @type {Array<Record<string, unknown>>} */
        const configured = [];
        incarnations.push(configured);
        return makeProviderBrokerServiceKit({
          ...options,
          admits: async () => true,
          runtimeKit: {
            open: async () => harden({}),
            close: async () => {},
            configure: async next => {
              configured.push(next);
            },
          },
        });
      }
    ),
  });
  /** @type {(reason: unknown) => void} */
  let cancelFirst = () => {};
  const firstCancelled = new Promise((_resolve, reject) => {
    cancelFirst = reject;
  });
  const first = await make(
    secret(),
    Far('context', { whenCancelled: () => firstCancelled }),
    { env: {} },
  );
  t.deepEqual(incarnations[0], [], 'nothing saved yet: the minted values');
  await E(first).configure({
    maxSessions: 16,
    publicInternet: false,
    diagnostics: true,
  });
  const saved = JSON.parse(
    await readFile(join(directory, 'broker-settings.json'), 'utf8'),
  );
  t.deepEqual(saved, {
    maxSessions: 16,
    publicInternet: false,
    diagnostics: true,
  });
  t.is(
    (await stat(join(directory, 'broker-settings.json'))).mode % 0o1000,
    0o600,
  );
  // A partial change keeps the rest of what was saved.
  await E(first).configure({ diagnostics: false });
  // Revival (a crash, a cancellation, a daemon start) builds a new
  // incarnation from the formula: it applies the saved settings before the
  // service is handed out.
  cancelFirst(Error('revived'));
  await make(
    secret(),
    Far('context', { whenCancelled: () => new Promise(() => {}) }),
    { env: {} },
  );
  t.deepEqual(incarnations[1], [{ maxListeners: 16, publicInternet: false }]);
  t.deepEqual(
    JSON.parse(await readFile(join(directory, 'broker-settings.json'), 'utf8')),
    { maxSessions: 16, publicInternet: false, diagnostics: false },
  );
});

test('a refused capacity moves neither the broker nor the runtime', async t => {
  /** @type {Array<Record<string, unknown>>} */
  const configured = [];
  /** @type {any} */
  let issuerOptions;
  const broker = makeProviderBrokerKit({
    label: 'Settings fixture',
    policy: /** @type {any} */ ({}),
    accountRef: 'account',
    secret: Far('secret', { readBase64: async () => '' }),
    admits: async () => true,
    ownerId: 'settings-fixture',
    directory: '/tmp/settings-fixture-never-opened',
    imageRef: `localhost/fixture@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/fixture@${digest}`,
    publicInternet: true,
    runtimeKit: /** @type {any} */ ({
      open: async () => harden({}),
      close: async () => {},
      configure: async next => {
        configured.push(next);
      },
    }),
    makeIssuer: /** @type {any} */ (
      options => {
        issuerOptions = options;
        return harden({ dispose: async () => {} });
      }
    ),
  });
  t.teardown(broker.close);
  await broker.start();
  for (const maxSessions of [1.5, 0, 257]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => broker.configure({ maxSessions, publicInternet: false }),
      { message: /Invalid listener capacity/ },
    );
  }
  t.true(issuerOptions.allowsPublicNetwork());
  t.deepEqual(configured, []);
});

test('an intent that fails to apply is still what a revived broker takes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'broker-settings-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  let failStop = true;
  /** @type {Array<Array<Record<string, unknown>>>} */
  const incarnations = [];
  const make = makeOwnedProviderBrokerService({
    label: 'Settings fixture',
    log: () => {},
    readConfig: () =>
      /** @type {any} */ ({
        ownerId: 'settings-partial',
        directory,
        imageRef: `localhost/fixture@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/fixture@${digest}`,
        publicInternet: true,
      }),
    makePolicy: () =>
      /** @type {any} */ ({ policy: {}, accountAuthority: 'fixture' }),
    makeServiceKit: /** @type {any} */ (
      options => {
        /** @type {Array<Record<string, unknown>>} */
        const configured = [];
        incarnations.push(configured);
        return makeProviderBrokerServiceKit({
          ...options,
          admits: async () => true,
          runtimeKit: {
            open: async () => harden({}),
            close: async () => {},
            configure: async next => {
              configured.push(next);
              // A live public listener that will not stop.
              if (next.publicInternet === false && failStop)
                throw Error('Public listener shutdown pending');
            },
          },
        });
      }
    ),
  });
  const secret = () => Far('secret', { readBase64: async () => '' });
  /** @type {(reason: unknown) => void} */
  let cancelFirst = () => {};
  const firstCancelled = new Promise((_resolve, reject) => {
    cancelFirst = reject;
  });
  const first = await make(
    secret(),
    Far('context', { whenCancelled: () => firstCancelled }),
    { env: {} },
  );
  await t.throwsAsync(() => E(first).configure({ publicInternet: false }), {
    message: /shutdown pending/,
  });
  t.deepEqual(
    JSON.parse(await readFile(join(directory, 'broker-settings.json'), 'utf8')),
    { publicInternet: false },
  );
  failStop = false;
  cancelFirst(Error('revived'));
  await make(
    secret(),
    Far('context', { whenCancelled: () => new Promise(() => {}) }),
    { env: {} },
  );
  t.deepEqual(incarnations[1], [{ publicInternet: false }]);
});

test('a malformed settings file refuses the revival and names the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'broker-settings-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'broker-settings.json'),
    JSON.stringify({ maxSessions: 1.5 }),
  );
  const make = makeOwnedProviderBrokerService({
    label: 'Settings fixture',
    log: () => {},
    readConfig: () =>
      /** @type {any} */ ({
        ownerId: 'settings-malformed',
        directory,
        imageRef: `localhost/fixture@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/fixture@${digest}`,
      }),
    makePolicy: () =>
      /** @type {any} */ ({ policy: {}, accountAuthority: 'fixture' }),
    makeServiceKit: /** @type {any} */ (
      options =>
        makeProviderBrokerServiceKit({
          ...options,
          admits: async () => true,
          runtimeKit: {
            open: async () => harden({}),
            close: async () => {},
            configure: async () => {},
          },
        })
    ),
  });
  await t.throwsAsync(
    () =>
      make(
        Far('secret', { readBase64: async () => '' }),
        Far('context', { whenCancelled: () => new Promise(() => {}) }),
        { env: {} },
      ),
    { message: /broker-settings\.json.*unreadable.*remove the file/ },
  );
});
