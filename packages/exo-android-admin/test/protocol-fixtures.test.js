// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';
import { readFileSync } from 'node:fs';

import { makeAndroidAdminAndControl } from '../src/android-admin.js';
import { ACTION_NAMES, PROTOCOL_VERSION } from '../src/protocol.js';
import { ALL_ACTIONS } from '../src/policy.js';

/**
 * The cross-language golden fixtures.  The Kotlin/Robolectric half of the
 * bridge asserts the mirror image of everything asserted here — that decoding
 * each `request` dispatches to the expected `DevicePolicyManager` call, and
 * that the outcome encodes to `result`.  Because both halves are pinned to
 * the same file, wire drift fails in CI on either side independently and
 * never has to be discovered on a physical device.
 */
const fixtures = JSON.parse(
  readFileSync(new URL('../protocol/fixtures.json', import.meta.url), 'utf-8'),
);

/** A policy granting everything: these tests are about the wire, not policy. */
const fullPolicy = harden({
  allowedActions: ALL_ACTIONS,
  allowedPackages: ['com.example.app'],
  allowedRestrictions: ['no_install_apps'],
  allowDestructive: true,
});

/**
 * Build a client whose transport answers with `result` and records requests.
 *
 * @param {unknown} result
 */
const makeClientAnswering = result => {
  /** @type {any[]} */
  const requests = [];
  const { client } = makeAndroidAdminAndControl({
    transport: async request => {
      requests.push(request);
      return /** @type {any} */ (result);
    },
    policy: fullPolicy,
  });
  return { client, requests };
};

test('fixtures declare the current protocol version', t => {
  t.is(fixtures.version, PROTOCOL_VERSION);
});

test('fixtures cover every action in the catalog', t => {
  const covered = new Set(
    /** @type {any[]} */ (fixtures.cases).map(kase => kase.action),
  );
  const missing = ACTION_NAMES.filter(name => !covered.has(name));
  t.deepEqual(
    missing,
    [],
    `every catalog action needs a fixture; missing: ${missing.join(', ')}`,
  );
});

for (const kase of /** @type {any[]} */ (fixtures.cases)) {
  test(`fixture produces the request: ${kase.name}`, async t => {
    const { client, requests } = makeClientAnswering(harden(kase.result));
    await /** @type {any} */ (client)[kase.action](...kase.positional);
    t.deepEqual(
      JSON.parse(JSON.stringify(requests[0])),
      kase.request,
      'the exo must build exactly the fixture request',
    );
  });

  test(`fixture consumes the result: ${kase.name}`, async t => {
    const { client } = makeClientAnswering(harden(kase.result));
    const value = await /** @type {any} */ (client)[kase.action](
      ...kase.positional,
    );
    // JSON cannot represent `undefined`, so `null` stands for it in the file.
    const expected = kase.value === null ? undefined : kase.value;
    t.deepEqual(
      value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
      expected,
    );
  });
}

for (const kase of /** @type {any[]} */ (fixtures.failureCases)) {
  test(`fixture failure rejects: ${kase.name}`, async t => {
    const { client } = makeClientAnswering(harden(kase.result));
    await t.throwsAsync(
      () => /** @type {any} */ (client)[kase.action](...kase.positional),
      { message: new RegExp(kase.messageIncludes) },
      'a failure envelope must surface as a rejection naming the cause',
    );
  });
}
