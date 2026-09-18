// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  listenerDiagnostics,
  makeOwnedProviderBrokerService,
} from '../src/provider-broker-service.js';

const encode = text => new TextEncoder().encode(text);

test('listener diagnostics are the worker lines and nothing else on the stream', t => {
  t.deepEqual(
    listenerDiagnostics(
      encode(
        [
          'SES Removing unpermitted intrinsics',
          'Provider HTTP diagnostic: {"stage":"endpoint"}',
          'Provider HTTP diagnostic: {"stage":"headers","checks":{"authorization":false,"path":true,"note":"canary"}}',
          'Provider HTTP diagnostic: {"stage":"end',
          'Provider HTTP diagnostic: {"stage":42}',
          '',
        ].join('\n'),
      ),
    ),
    [
      { stage: 'endpoint' },
      { stage: 'headers', checks: { authorization: false, path: true } },
    ],
  );
});

/**
 * Open an owned broker service over a recording kit and return the options
 * the kit was constructed with.
 * @param {boolean | undefined} diagnostics
 * @param {(...args: string[]) => void} log
 */
const kitOptionsFor = async (diagnostics, log) => {
  /** @type {any} */
  let seen;
  const make = makeOwnedProviderBrokerService({
    label: 'Test',
    log,
    readConfig: () =>
      /** @type {any} */ ({ ownerId: `owner-${diagnostics}`, diagnostics }),
    makePolicy: () => /** @type {any} */ ({ policy: {}, accountRef: 'a' }),
    makeServiceKit: /** @type {any} */ (
      options => {
        seen = options;
        return { service: Far('service', {}), close: async () => {} };
      }
    ),
  });
  const context = Far('context', { whenCancelled: () => new Promise(() => {}) });
  await make(Far('secret', { readBase64: async () => '' }), context, {
    env: {},
  });
  return seen;
};

test('failure hooks do not depend on the diagnostics flag; the admission trail does', async t => {
  /** @type {string[]} */
  const logged = [];
  const log = (...args) => logged.push(args.join(' '));
  for (const flag of [undefined, false, true]) {
    // eslint-disable-next-line no-await-in-loop
    const options = await kitOptionsFor(flag, log);
    t.is(typeof options.onDiagnostic, 'function', `${flag}`);
    t.is(typeof options.onListenerDiagnostic, 'function', `${flag}`);
    t.is(typeof options.audit, flag === true ? 'function' : 'undefined');
    options.onDiagnostic({ stage: 'response', status: 429 });
    options.onListenerDiagnostic({ stage: 'endpoint' });
    if (flag === true) options.audit({ event: 'admitted', requests: 1n });
  }
  t.is(logged.filter(line => line === 'Test broker event admitted 1').length, 1);
  t.is(
    logged.filter(
      line => line === 'Test upstream failure {"stage":"response","status":429}',
    ).length,
    3,
  );
  t.is(
    logged.filter(line => line === 'Test listener failure {"stage":"endpoint"}')
      .length,
    3,
  );
});
