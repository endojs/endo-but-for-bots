// @ts-check
/* global process */

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { makeCancelKit } from '@endo/cancel';
import { makeEndoClient, purge, restart, start, stop } from '@endo/daemon';
import { E } from '@endo/eventual-send';

import { makeMockPrivacyApi } from './mock-privacy-api.js';

const API_KEY = 'test-key-do-not-leak';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Some environments run the daemon suite against the Rust supervisor
// (ENDO_BIN) without a Node worker binary; unconfined caplets need a
// Node worker, so skip there — same guard as the daemon's own suite.
// Serial either way: these tests fork a full daemon each.
const testNeedsNodeWorker = /** @type {typeof test.serial} */ (
  process.env.ENDO_BIN && !process.env.ENDO_NODE_WORKER_BIN
    ? test.serial.skip
    : test.serial
);

/** @param {string} name */
const makeConfig = name => {
  const root = path.join(dirname, 'tmp', name);
  return {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\privacy-cards-${name}-test.sock`
        : path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * @param {ReturnType<typeof makeConfig>} config
 * @param {Promise<void>} cancelled
 * @returns {Promise<any>} the host facet, deliberately untyped: these
 * tests exercise the caplet across CapTP, where everything is `any`.
 */
const makeHost = async (config, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  // Sink teardown-induced connection closure.
  closed.catch(() => {});
  return E(/** @type {any} */ (getBootstrap())).host();
};

// Forks a full daemon, so it must not share filesystem state or ports
// with a sibling test: serial, like all daemon-forking suites.
testNeedsNodeWorker(
  'caplet, budget, and per-grant eval formula survive a daemon restart',
  async t => {
    t.timeout(120_000);
    const api = await makeMockPrivacyApi({ apiKey: API_KEY });
    t.teardown(() => api.close());

    const { cancelled, cancel } = makeCancelKit();
    const config = makeConfig('restart');
    await purge(config);
    await start(config);
    t.teardown(async () => {
      await stop(config);
      cancelled.catch(() => {});
      cancel(new Error('teardown'));
    });

    const capletLocation = url.pathToFileURL(
      path.join(dirname, '..', 'src', 'caplet.js'),
    ).href;
    const stateFile = path.join(dirname, 'tmp', 'restart', 'ledger.json');
    // The daemon's purge() clears its own state; the caplet's ledger
    // file must not leak in from a previous run.
    fs.rmSync(stateFile, { force: true });

    {
      const host = await makeHost(config, cancelled);
      await E(host).provideWorker(['w1']);
      const account = await E(host).makeUnconfined('w1', capletLocation, {
        powersName: '@none',
        resultName: 'privacy-account',
        env: {
          PRIVACY_API_KEY: API_KEY,
          PRIVACY_API_BASE_URL: api.baseUrl,
          PRIVACY_STATE_FILE: stateFile,
        },
      });
      t.true(await E(account).status());

      // Mint the grant once, imperatively.
      await E(account).makeIssuer('bob', harden({ budgetCents: 100_000 }));

      // Durable per-grant reference: an eval formula over provideIssuer.
      // The formula — not the live object — is what persists, so after
      // a restart the daemon re-evaluates it: the account caplet
      // re-runs (reloading the ledger from PRIVACY_STATE_FILE) and
      // re-derives the same grant's issuer facet.
      const issuer = await E(host).evaluate(
        'w1',
        `E(account).provideIssuer('bob').then(kit => kit.issuer)`,
        ['account'],
        ['privacy-account'],
        ['bob-issuer'],
      );

      const card = await E(issuer).createCard(
        harden({ spendLimitCents: 60_000 }),
      );
      t.regex(card.pan, /^\d{16}$/);
      t.is(await E(issuer).remainingCents(), 40_000);
      t.is(api.cards.get(card.cardToken).spend_limit, 60_000);
    }

    await restart(config);

    {
      const host = await makeHost(config, cancelled);
      // The pet name re-derives the issuer through the formula graph.
      const issuer = await E(host).lookup(['bob-issuer']);
      t.is(await E(issuer).remainingCents(), 40_000);
      await E(issuer).createCard(harden({ spendLimitCents: 40_000 }));
      await t.throwsAsync(
        () => E(issuer).createCard(harden({ spendLimitCents: 1 })),
        { message: /exceeds the remaining budget/ },
      );

      // The account also recovers directly, for the owner's side.
      const account = await E(host).lookup(['privacy-account']);
      const [grant] = await E(account).listGrants();
      t.is(grant.name, 'bob');
      t.is(grant.remainingCents, 0);
    }
  },
);

testNeedsNodeWorker(
  'the issuer facet crosses CapTP with its guards and without the key',
  async t => {
    t.timeout(120_000);
    const api = await makeMockPrivacyApi({ apiKey: API_KEY });
    t.teardown(() => api.close());

    const { cancelled, cancel } = makeCancelKit();
    const config = makeConfig('captp');
    await purge(config);
    await start(config);
    t.teardown(async () => {
      await stop(config);
      cancelled.catch(() => {});
      cancel(new Error('teardown'));
    });

    const capletLocation = url.pathToFileURL(
      path.join(dirname, '..', 'src', 'caplet.js'),
    ).href;

    const host = await makeHost(config, cancelled);
    await E(host).provideWorker(['w1']);
    const account = await E(host).makeUnconfined('w1', capletLocation, {
      powersName: '@none',
      resultName: 'privacy-account',
      env: {
        PRIVACY_API_KEY: API_KEY,
        PRIVACY_API_BASE_URL: api.baseUrl,
      },
    });

    const { issuer, control } = await E(account).makeIssuer(
      'agent',
      harden({ budgetCents: 50_000 }),
    );

    // Interface guards hold at the CapTP boundary.
    await t.throwsAsync(
      () => E(issuer).createCard(harden({ spendLimitCents: 'lots' })),
      { message: /Must be a number/ },
    );
    // CapTP introspection sees the guarded methods, none of which can
    // yield the key.
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(issuer).__getMethodNames__();
    t.true(methods.includes('createCard'));
    for (const name of methods) {
      t.false(/key|secret/i.test(String(name)));
    }

    // The full loop over the wire: create, spend, close, reclaim.
    const card = await E(issuer).createCard(
      harden({ spendLimitCents: 20_000, memo: 'headphones' }),
    );
    api.addTransaction(card.cardToken, {
      amount: -15_000,
      result: 'APPROVED',
      status: 'SETTLED',
    });
    t.is(await E(issuer).closeCard(card.cardToken), 5000);
    t.is(await E(issuer).remainingCents(), 35_000);

    const { pausedCardTokens } = await E(control).revoke();
    t.deepEqual(pausedCardTokens, []);
    await t.throwsAsync(
      () => E(issuer).createCard(harden({ spendLimitCents: 1 })),
      { message: /has been revoked/ },
    );
  },
);
