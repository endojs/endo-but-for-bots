// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';
import {
  makeAndroidAdminAndControl,
  ALL_ACTIONS,
} from '@endo/exo-android-admin';

import { makeMockDeviceBridge } from '../src/mock-bridge.js';

/**
 * The mock stands in for the privileged Android side, so these tests are the
 * desktop half of the cross-language contract: the exo drives real requests
 * through a real dispatcher and the resulting device state is asserted. The
 * Kotlin implementation is held to the same fixtures.
 *
 * @param {object} [options]
 */
const makeAdminOverMock = (options = {}) => {
  const { transport, state } = makeMockDeviceBridge(options);
  const { client, control } = makeAndroidAdminAndControl({
    transport,
    policy: {
      allowedActions: ALL_ACTIONS,
      allowedPackages: ['com.example.app'],
      allowedRestrictions: ['no_install_apps'],
      allowDestructive: true,
    },
  });
  return { client, control, state };
};

test('mutations reach the fake device policy manager', async t => {
  await null;
  const { client, state } = makeAdminOverMock();

  await client.lockNow();
  await client.setCameraDisabled(true);
  await client.setMaximumTimeToLock(60_000);
  await client.setRequiredPasswordComplexity('high');
  await client.addUserRestriction('no_install_apps');
  await client.setApplicationHidden('com.example.app', true);

  t.is(state.lockCount, 1);
  t.true(state.cameraDisabled);
  t.is(state.maximumTimeToLockMs, 60_000);
  t.is(state.passwordComplexity, 'high');
  t.deepEqual([...state.restrictions], ['no_install_apps']);
  t.deepEqual([...state.hiddenPackages], ['com.example.app']);
});

test('queries read back the state mutations wrote', async t => {
  await null;
  const { client } = makeAdminOverMock();

  t.false(await client.isApplicationHidden('com.example.app'));
  await client.setApplicationHidden('com.example.app', true);
  t.true(await client.isApplicationHidden('com.example.app'));

  await client.addUserRestriction('no_install_apps');
  t.deepEqual(await client.listUserRestrictions(), ['no_install_apps']);
});

test('getDeviceState reports device-owner status', async t => {
  await null;
  const { client } = makeAdminOverMock({ deviceOwner: true });
  const state = await client.getDeviceState();
  t.true(state.deviceOwner);
  t.is(state.model, 'SM-A375F');
});

test('without device-owner status privileged actions fail as SecurityException', async t => {
  await null;
  const { client } = makeAdminOverMock({ deviceOwner: false });

  // The one action that must still answer: an operator has to be able to see
  // *that* provisioning failed.
  const state = await client.getDeviceState();
  t.false(state.deviceOwner);

  await t.throwsAsync(() => client.lockNow(), {
    message: /SecurityException/,
  });
});

test('destructive actions are recorded distinctly', async t => {
  await null;
  const { client, state } = makeAdminOverMock();

  await client.reboot();
  await client.wipeData('decommissioned by HQ');

  t.is(state.rebootCount, 1);
  t.true(state.wiped);
  t.is(state.wipeReason, 'decommissioned by HQ');
});

test('a policy without allowDestructive keeps the device intact', async t => {
  await null;
  const { transport, state } = makeMockDeviceBridge();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ALL_ACTIONS },
  });

  await t.throwsAsync(() => client.wipeData('nope'), {
    message: /destructive/,
  });
  await t.throwsAsync(() => client.reboot(), { message: /destructive/ });

  t.false(state.wiped);
  t.is(state.rebootCount, 0);
});

test('revocation stops mutations from reaching the device', async t => {
  await null;
  const { client, control, state } = makeAdminOverMock();

  await client.lockNow();
  control.revoke();
  await t.throwsAsync(() => client.lockNow(), { message: /revoked/ });

  t.is(state.lockCount, 1, 'the post-revocation call never reached the device');
});

test('an unknown protocol version is refused', async t => {
  await null;
  const { transport } = makeMockDeviceBridge();
  const result = await transport(
    harden({ v: 99, action: 'lockNow', args: {} }),
  );
  t.like(result, { ok: false, error: { name: 'UnsupportedVersion' } });
});

test('an unknown action is refused rather than silently ignored', async t => {
  await null;
  const { transport } = makeMockDeviceBridge();
  const result = await transport(
    harden({ v: 1, action: 'selfDestruct', args: {} }),
  );
  t.like(result, { ok: false, error: { name: 'UnknownAction' } });
});
