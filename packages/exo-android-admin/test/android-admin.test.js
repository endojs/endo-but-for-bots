// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';

import { makeAndroidAdminAndControl } from '../src/android-admin.js';
import { ALL_ACTIONS } from '../src/policy.js';

/**
 * A recording transport.  Captures every request the exo builds and answers
 * from a scripted queue, so policy, guard, and envelope behavior are all
 * observable without an Android device or even a bridge.
 *
 * @param {object} [options]
 * @param {unknown} [options.value] - default success value.
 */
const makeRecordingTransport = ({ value } = {}) => {
  /** @type {import('../src/types.js').AdminRequest[]} */
  const requests = [];
  /** @type {import('../src/types.js').AdminResult[]} */
  const scripted = [];
  const transport = async (/** @type {any} */ request) => {
    requests.push(request);
    const next = scripted.shift();
    return next ?? harden({ ok: true, value });
  };
  // Deliberately not hardened: `harden` is deep, and freezing the recorder
  // would freeze the `requests` log it exists to accumulate.
  return {
    transport,
    requests,
    /** @param {import('../src/types.js').AdminResult} result */
    script: result => {
      scripted.push(result);
    },
  };
};

/** A policy granting everything, for tests that are not about policy. */
const fullPolicy = harden({
  allowedActions: ALL_ACTIONS,
  allowedPackages: ['com.example.app'],
  allowedRestrictions: ['no_install_apps'],
  allowDestructive: true,
});

test('client builds the catalog request shape', async t => {
  const { transport, requests } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });

  await client.setApplicationHidden('com.example.app', true);

  t.deepEqual(requests, [
    {
      v: 1,
      action: 'setApplicationHidden',
      args: { packageName: 'com.example.app', hidden: true },
    },
  ]);
});

test('an omitted optional argument is absent, not null', async t => {
  const { transport, requests } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });

  await client.wipeData();

  t.deepEqual(requests[0].args, {});
  t.false('reason' in requests[0].args);
});

test('a failure envelope becomes a rejection', async t => {
  const recorder = makeRecordingTransport();
  recorder.script(
    harden({
      ok: false,
      error: { name: 'SecurityException', message: 'Not device owner' },
    }),
  );
  const { client } = makeAndroidAdminAndControl({
    transport: recorder.transport,
    policy: fullPolicy,
  });

  await t.throwsAsync(() => client.lockNow(), {
    message: /SecurityException/,
  });
});

test('a malformed result envelope is rejected, not treated as success', async t => {
  const recorder = makeRecordingTransport();
  recorder.script(/** @type {any} */ (harden({ nonsense: true })));
  const { client } = makeAndroidAdminAndControl({
    transport: recorder.transport,
    policy: fullPolicy,
  });

  await t.throwsAsync(() => client.lockNow(), {
    message: /malformed result envelope/,
  });
});

// #region Policy

test('an action outside the allowlist never reaches the bridge', async t => {
  const { transport, requests } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ['getDeviceState'] },
  });

  await t.throwsAsync(() => client.lockNow(), {
    message: /not permitted by policy/,
  });
  // The point of checking before building: nothing crossed the seam.
  t.deepEqual(requests, []);
});

test('a destructive action needs allowDestructive even when allowlisted', async t => {
  const { transport, requests } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ['wipeData', 'reboot'] },
  });

  await t.throwsAsync(() => client.wipeData('oops'), {
    message: /destructive/,
  });
  await t.throwsAsync(() => client.reboot(), { message: /destructive/ });
  t.deepEqual(requests, []);
});

test('a package-scoped action is bounded by allowedPackages', async t => {
  const { transport } = makeRecordingTransport({ value: false });
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: {
      allowedActions: ['isApplicationHidden'],
      allowedPackages: ['com.example.app'],
    },
  });

  const hidden = await client.isApplicationHidden('com.example.app');
  t.false(hidden);
  await t.throwsAsync(() => client.isApplicationHidden('com.other.app'), {
    message: /may not target/,
  });
});

test('a restriction-scoped action is bounded by allowedRestrictions', async t => {
  const { transport } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: {
      allowedActions: ['addUserRestriction'],
      allowedRestrictions: ['no_install_apps'],
    },
  });

  await client.addUserRestriction('no_install_apps');
  await t.throwsAsync(() => client.addUserRestriction('no_factory_reset'), {
    message: /may not target/,
  });
});

test('an unknown action name in a policy is rejected, not ignored', t => {
  const { transport } = makeRecordingTransport();
  t.throws(
    () =>
      makeAndroidAdminAndControl({
        transport,
        policy: { allowedActions: ['lockNwo'] },
      }),
    { message: /unknown admin action/ },
  );
});

test('a mutated policy array cannot widen authority after construction', async t => {
  const { transport } = makeRecordingTransport();
  const allowedActions = ['getDeviceState'];
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions },
  });

  allowedActions.push('wipeData');

  await t.throwsAsync(() => client.lockNow(), {
    message: /not permitted by policy/,
  });
});

// #endregion

// #region Attenuation

test('attenuate narrows and can never widen', async t => {
  const { transport } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ['lockNow', 'setCameraDisabled'] },
  });

  const cameraOnly = client.attenuate({
    allowedActions: ['setCameraDisabled'],
  });
  await cameraOnly.setCameraDisabled(true);
  await t.throwsAsync(() => cameraOnly.lockNow(), {
    message: /not permitted by policy/,
  });

  // Asking for more than the parent holds yields nothing extra.
  const greedy = cameraOnly.attenuate({
    allowedActions: ['lockNow', 'setCameraDisabled', 'reboot'],
  });
  t.deepEqual(greedy.inspect().allowedActions, ['setCameraDisabled']);
  await t.throwsAsync(() => greedy.lockNow(), {
    message: /not permitted by policy/,
  });
});

test('attenuate cannot re-enable destructive actions', async t => {
  const { transport } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ['reboot'], allowDestructive: false },
  });

  const derived = client.attenuate({
    allowedActions: ['reboot'],
    allowDestructive: true,
  });

  await t.throwsAsync(() => derived.reboot(), { message: /destructive/ });
  t.false(derived.inspect().allowDestructive);
});

test('narrowing the parent narrows facets already derived from it', async t => {
  const { transport } = makeRecordingTransport();
  const { client, control } = makeAndroidAdminAndControl({
    transport,
    policy: { allowedActions: ['lockNow', 'setCameraDisabled'] },
  });
  const derived = client.attenuate({
    allowedActions: ['lockNow', 'setCameraDisabled'],
  });

  await derived.lockNow();

  control.setPolicy({ allowedActions: ['setCameraDisabled'] });

  // The derived facet tracks the live parent rather than a stale snapshot.
  await t.throwsAsync(() => derived.lockNow(), {
    message: /not permitted by policy/,
  });
  await derived.setCameraDisabled(true);
  t.deepEqual(derived.inspect().allowedActions, ['setCameraDisabled']);
});

// #endregion

// #region Revocation and facet asymmetry

test('revoke severs the client and every facet derived from it', async t => {
  const { transport } = makeRecordingTransport();
  const { client, control } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });
  const derived = client.attenuate({ allowedActions: ['lockNow'] });

  await client.lockNow();
  await derived.lockNow();

  control.revoke();

  await t.throwsAsync(() => client.lockNow(), { message: /revoked/ });
  await t.throwsAsync(() => derived.lockNow(), { message: /revoked/ });
  t.true(control.isRevoked());
  t.true(client.inspect().revoked);
  t.true(derived.inspect().revoked);
});

test('a facet derived after revocation is also dead', async t => {
  const { transport } = makeRecordingTransport();
  const { client, control } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });
  control.revoke();

  const derived = client.attenuate({ allowedActions: ['lockNow'] });
  await t.throwsAsync(() => derived.lockNow(), { message: /revoked/ });
});

test('setPolicy is refused after revocation', t => {
  const { transport } = makeRecordingTransport();
  const { control } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });
  control.revoke();

  t.throws(() => control.setPolicy({ allowedActions: ['lockNow'] }), {
    message: /revoked/,
  });
});

test('the client facet exposes no control methods', t => {
  const { transport } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });

  // The guard defines the surface; these are the powers that must not leak.
  t.is(/** @type {any} */ (client).revoke, undefined);
  t.is(/** @type {any} */ (client).setPolicy, undefined);
  t.is(/** @type {any} */ (client).isRevoked, undefined);
});

test('inspect reports the bounds and never the transport', t => {
  const { transport } = makeRecordingTransport();
  const { client, control } = makeAndroidAdminAndControl({
    transport,
    policy: {
      allowedActions: ['lockNow'],
      allowedPackages: ['com.example.app'],
    },
  });

  const expected = {
    allowedActions: ['lockNow'],
    allowedPackages: ['com.example.app'],
    allowedRestrictions: [],
    allowDestructive: false,
    revoked: false,
  };
  t.deepEqual(client.inspect(), expected);
  t.deepEqual(control.inspect(), expected);
});

// #endregion

test('the interface guard rejects a malformed call', async t => {
  const { transport, requests } = makeRecordingTransport();
  const { client } = makeAndroidAdminAndControl({
    transport,
    policy: fullPolicy,
  });

  // A boolean-typed argument passed a string: rejected by the guard, before
  // the method body and therefore before any policy check or request.
  await t.throwsAsync(() =>
    /** @type {any} */ (client).setCameraDisabled('yes'),
  );
  await t.throwsAsync(() =>
    /** @type {any} */ (client).setRequiredPasswordComplexity('extreme'),
  );
  t.deepEqual(requests, []);
});

test('a transport must be supplied', t => {
  t.throws(
    () =>
      makeAndroidAdminAndControl({
        transport: /** @type {any} */ (undefined),
        policy: fullPolicy,
      }),
    { message: /transport must be a function/ },
  );
});
