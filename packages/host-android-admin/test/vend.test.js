// End-to-end: two real Endo daemons standing in for the phone and HQ.
//
// The device daemon loads this package as an unconfined formula over the mock
// bridge, names both facets, and vends only the client facet to HQ through
// mail.  HQ adopts it and drives administration across CapTP.
//
// This is the test the design calls L2, and it is the highest-value one in the
// suite: it exercises the entire "vend admin control to HQ" path — formula,
// facet split, capability transfer, remote invocation, revocation — with
// nothing faked except the Android side of the bridge itself.
//
// Daemon tests are serial because each forks a full daemon process and shares
// filesystem state under `test/tmp`.

import '@endo/init/debug.js';

import test from 'ava';
import path from 'path';
import url from 'url';
import process from 'process';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';

/**
 * A remote `AndroidAdmin`, plus the introspection method every exo provides
 * over CapTP.  Naming it here keeps the assertions type-checked instead of
 * disabling the checker for the whole file.
 *
 * @typedef {import('@endo/exo-android-admin').AndroidAdmin & {
 *   __getMethodNames__: () => string[],
 * }} RemoteAdmin
 */

/** @typedef {import('@endo/exo-android-admin').AndroidAdminControl} AdminControl */

const dirname = url.fileURLToPath(new URL('.', import.meta.url));

const adminModuleHref = url.pathToFileURL(
  path.join(dirname, '..', 'src', 'index.js'),
).href;

const networkModuleHref = url.pathToFileURL(
  path.join(
    dirname,
    '..',
    '..',
    'daemon',
    'src',
    'networks',
    'tcp-netstring.js',
  ),
).href;

/**
 * The policy the device grants HQ.  Deliberately narrower than the catalog:
 * the test asserts both that permitted actions cross the wire and that the
 * bounds still hold at the far end of a remote reference.
 */
const policy = JSON.stringify({
  allowedActions: [
    'getDeviceState',
    'lockNow',
    'setApplicationHidden',
    'isApplicationHidden',
    'wipeData',
  ],
  allowedPackages: ['com.example.app'],
  // allowDestructive omitted: wipeData is allowlisted but must still fail.
});

let testCounter = 0;

const makeConfig = () => {
  testCounter += 1;
  const tag = String(testCounter).padStart(4, '0');
  const base = path.join(dirname, 'tmp', tag);
  return {
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\endo-android-admin-${tag}.sock`
        : path.join(base, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * Start a daemon with the TCP network installed, so two of them can exchange
 * an invitation.  Loopback TCP rather than iroh: this test is about the
 * capability path, and the transport underneath it is interchangeable.
 *
 * @param {import('ava').ExecutionContext<any>} t
 */
const prepareHost = async t => {
  const config = makeConfig();
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});

  await purge(config);
  await start(config);
  t.teardown(async () => {
    cancel(new Error('test teardown'));
    await stop(config).catch(() => {});
  });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});

  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();

  await E(host).storeValue('127.0.0.1:0', 'tcp-listen-addr');
  const network = await E(host).makeUnconfined('@main', networkModuleHref, {
    powersName: '@agent',
    resultName: 'test-network',
  });
  await network;
  await E(host).move(['test-network'], ['@nets', 'tcp']);

  return { host, config };
};

/**
 * Provision the device side: mint the admin kit over the mock bridge and name
 * the two facets separately, exactly as `setup-android.js` does.
 *
 * @param {any} host
 */
const provisionDevice = async host => {
  await E(host).makeUnconfined('@node', adminModuleHref, {
    powersName: '@none',
    env: { policy, bridge: 'mock' },
    resultName: 'android-admin-kit',
  });
  await E(host).evaluate(
    '@main',
    'E(kit).client()',
    ['kit'],
    ['android-admin-kit'],
    ['android-admin'],
  );
  await E(host).evaluate(
    '@main',
    'E(kit).control()',
    ['kit'],
    ['android-admin-kit'],
    ['android-admin-control'],
  );
};

/**
 * Establish an invitation between two hosts and vend the named capability
 * from `deviceHost` to `hqHost`, returning HQ's remote reference to it.
 *
 * @param {any} deviceHost
 * @param {any} hqHost
 * @returns {Promise<RemoteAdmin>}
 */
const vendAdminToHq = async (deviceHost, hqHost) => {
  const invitation = await E(deviceHost).invite('hq');
  const locator = await E(invitation).locate();
  await E(hqHost).accept(locator, 'device');

  await E(deviceHost).send(
    'hq',
    ['Android admin for this device'],
    ['admin'],
    ['android-admin'],
  );

  const messages = await E(hqHost).listMessages();
  const packaged = messages.find(
    message =>
      message.type === 'package' &&
      message.strings &&
      message.strings[0] === 'Android admin for this device',
  );
  if (packaged === undefined) {
    throw new Error('HQ never received the vended capability');
  }
  await E(hqHost).adopt(packaged.number, 'admin', ['remote-admin']);
  const adopted = await E(hqHost).lookup(['remote-admin']);
  return /** @type {RemoteAdmin} */ (adopted);
};

// Loading an unconfined formula needs a Node worker; the bare-rust supervisor
// path deliberately omits one.
// Already the serial variant: every case here forks two full daemons and
// shares filesystem state under `test/tmp`.
const testNeedsNodeWorker =
  process.env.ENDO_BIN && !process.env.ENDO_NODE_WORKER_BIN
    ? test.serial.skip
    : test.serial;

testNeedsNodeWorker(
  'HQ administers the device through a vended capability',
  async t => {
    t.timeout(120_000);
    const { host: deviceHost } = await prepareHost(t);
    const { host: hqHost } = await prepareHost(t);

    await provisionDevice(deviceHost);
    const remoteAdmin = await vendAdminToHq(deviceHost, hqHost);

    // A query round-trips into the device's worker, where the mock bridge
    // lives, and back.
    const state = await E(remoteAdmin).getDeviceState();
    t.true(state.deviceOwner, 'HQ can read device state remotely');
    t.is(state.model, 'SM-A375F');

    // A mutation issued from HQ is observable through a subsequent query from
    // HQ: the state it changed lives on the device, not in HQ's process.
    t.false(await E(remoteAdmin).isApplicationHidden('com.example.app'));
    await E(remoteAdmin).setApplicationHidden('com.example.app', true);
    t.true(
      await E(remoteAdmin).isApplicationHidden('com.example.app'),
      'the mutation took effect on the device',
    );

    await E(remoteAdmin).lockNow();
    t.pass('HQ locked the device');
  },
);

testNeedsNodeWorker(
  'policy bounds hold at the far end of a remote reference',
  async t => {
    t.timeout(120_000);
    const { host: deviceHost } = await prepareHost(t);
    const { host: hqHost } = await prepareHost(t);

    await provisionDevice(deviceHost);
    const remoteAdmin = await vendAdminToHq(deviceHost, hqHost);

    // Allowlisted but destructive, and the policy withheld allowDestructive:
    // the device refuses even though HQ holds the capability.
    await t.throwsAsync(() => E(remoteAdmin).wipeData('from HQ'), {
      message: /destructive/,
    });

    // Not in the action allowlist at all.
    await t.throwsAsync(() => E(remoteAdmin).reboot(), {
      message: /not permitted by policy/,
    });

    // In the allowlist, but outside the package allowlist.
    await t.throwsAsync(
      () => E(remoteAdmin).setApplicationHidden('com.other.app', true),
      { message: /may not target/ },
    );
  },
);

testNeedsNodeWorker(
  'the vended facet carries no control authority',
  async t => {
    t.timeout(120_000);
    const { host: deviceHost } = await prepareHost(t);
    const { host: hqHost } = await prepareHost(t);

    await provisionDevice(deviceHost);
    const remoteAdmin = await vendAdminToHq(deviceHost, hqHost);

    // Ask the remote object what it is rather than duck-typing: a failed
    // CapTP call per absent method would be noise, and __getMethodNames__ is
    // the interface the exo already provides for exactly this.
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(remoteAdmin).__getMethodNames__();
    t.true(methods.includes('lockNow'), 'the client surface crossed the wire');
    t.true(methods.includes('attenuate'));
    for (const forbidden of ['revoke', 'setPolicy', 'isRevoked']) {
      t.false(
        methods.includes(forbidden),
        `${forbidden} must not be reachable from the vended facet`,
      );
    }
  },
);

testNeedsNodeWorker('revoking on the device severs HQ', async t => {
  t.timeout(120_000);
  const { host: deviceHost } = await prepareHost(t);
  const { host: hqHost } = await prepareHost(t);

  await provisionDevice(deviceHost);
  const remoteAdmin = await vendAdminToHq(deviceHost, hqHost);

  await E(remoteAdmin).lockNow();

  // The device retained the control facet and can act unilaterally: HQ is
  // not consulted and cannot decline.
  const control = /** @type {AdminControl} */ (
    await E(deviceHost).lookup(['android-admin-control'])
  );
  await E(control).revoke();

  await t.throwsAsync(() => E(remoteAdmin).lockNow(), {
    message: /revoked/,
  });
  t.true(await E(control).isRevoked());
});

testNeedsNodeWorker(
  'HQ can attenuate the vended capability before delegating it onward',
  async t => {
    t.timeout(120_000);
    const { host: deviceHost } = await prepareHost(t);
    const { host: hqHost } = await prepareHost(t);

    await provisionDevice(deviceHost);
    const remoteAdmin = await vendAdminToHq(deviceHost, hqHost);

    const readOnly = await E(remoteAdmin).attenuate({
      allowedActions: ['getDeviceState'],
    });

    const state = await E(readOnly).getDeviceState();
    t.true(state.deviceOwner);
    await t.throwsAsync(() => E(readOnly).lockNow(), {
      message: /not permitted by policy/,
    });

    // Narrowing a delegate does not narrow the delegator.
    await E(remoteAdmin).lockNow();
    t.pass('the parent capability is unaffected by the derived one');
  },
);
