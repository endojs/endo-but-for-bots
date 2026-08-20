// @ts-check

/**
 * The `http` root field of `EndoProvisionSpec`, end to end: a session
 * provisioned with it gets a confined `HttpClient` as a proper code-mode
 * global, performs a request through it against a real listener, and is
 * refused for an origin its policy does not name.
 */

import '@endo/init/debug.js';

import test from 'ava';

import { createServer } from 'node:http';

import { E } from '@endo/eventual-send';

/* eslint-disable import/no-relative-packages */
import {
  normalizeEndoProvisionSpec,
  provisionEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
/* eslint-enable import/no-relative-packages */

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';

/**
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<{ origin: string, hits: () => string[] }>}
 */
const startOriginServer = async t => {
  /** @type {string[]} */
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.teardown(
    () => new Promise(resolve => server.close(() => resolve(undefined))),
  );
  const address = server.address();
  const port =
    address !== null && typeof address === 'object' ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, hits: () => [...hits] };
};

test('the http grant normalizes through the daemon validator', async t => {
  const persistence = await normalizeEndoProvisionSpec(
    {
      http: {
        allowedOrigins: ['https://api.example.com'],
        maxRequestsPerMinute: 10,
      },
    },
    { harness: 'test', sessionId: 'http-normalize', cwd: process.cwd() },
  );
  t.deepEqual(persistence.policy.http, {
    allowedOrigins: ['https://api.example.com'],
    maxRequestsPerMinute: 10,
    // The daemon's own defaults, baked in so the record is self-describing.
    maxResponseBytes: 1024 * 1024,
    policyMode: 'strict',
  });

  // Delegated, not restated: these diagnoses come from the daemon's validator.
  await t.throwsAsync(
    normalizeEndoProvisionSpec(
      { http: { allowedOrigins: ['https://api.example.com/path'] } },
      { harness: 'test', sessionId: 'http-bad-origin', cwd: process.cwd() },
    ),
    { message: /must be exactly an http\(s\) origin/ },
  );
  await t.throwsAsync(
    normalizeEndoProvisionSpec(
      { http: { maxResponseBytes: 0 } },
      { harness: 'test', sessionId: 'http-bad-bytes', cwd: process.cwd() },
    ),
    { message: /maxResponseBytes must be a positive safe integer/ },
  );
  await t.throwsAsync(
    normalizeEndoProvisionSpec(
      // A mode that needs a live authority a retained formula cannot hold.
      { http: { policyMode: /** @type {any} */ ('tofu-prompt') } },
      { harness: 'test', sessionId: 'http-bad-mode', cwd: process.cwd() },
    ),
    { message: /policyMode must be one of/ },
  );
});

test('the http grant cannot be shadowed by another binding', async t => {
  await t.throwsAsync(
    normalizeEndoProvisionSpec(
      {
        http: { allowedOrigins: ['https://api.example.com'] },
        mounts: { http: { path: '.', mode: 'readOnly' } },
      },
      { harness: 'test', sessionId: 'http-collision', cwd: process.cwd() },
    ),
    { message: /must be a non-reserved JavaScript binding and pet name/ },
  );
});

test.serial(
  'a session provisioned with http requests through the granted client',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const endpoint = await startOriginServer(t);

    const session = fixture.trackSession(
      await provisionEndoCodeMode({
        harness: 'test',
        sessionId: 'http-session',
        cwd: fixture.workspace,
        sockPath: fixture.sockPath,
        spec: {
          http: {
            allowedOrigins: [endpoint.origin],
            maxRequestsPerMinute: 30,
          },
        },
      }),
    );

    // A proper code-mode global, not an opaque grant: the binding carries the
    // HttpClient's generated declaration.
    const httpGlobal = session.globals.find(global => global.name === 'http');
    t.truthy(httpGlobal, 'the session is told it has an `http` binding');
    t.truthy(
      httpGlobal?.declaration?.body,
      'the binding carries a generated declaration rather than `unknown`',
    );
    t.regex(String(httpGlobal?.declaration?.body), /fetch/);

    const httpGrant = session.grants.find(grant => grant.name === 'http');
    t.truthy(httpGrant);
    const client = /** @type {any} */ (httpGrant?.capability);

    const response = await E(client).fetch(`${endpoint.origin}/hello`);
    t.is(await E(response).status(), 200);
    t.deepEqual(await E(response).json(), {
      path: '/hello',
      method: 'GET',
    });
    t.deepEqual(endpoint.hits(), ['/hello']);

    t.deepEqual(await E(client).allowedOrigins(), [endpoint.origin]);

    // The policy is the host's. An origin it does not name is refused, and the
    // session holds no controller facet with which to widen it.
    await t.throwsAsync(E(client).fetch('https://elsewhere.example.com/'), {
      message: /not in the allowed-origin list/,
    });
    t.deepEqual(endpoint.hits(), ['/hello']);
    t.is(
      typeof (/** @type {any} */ (client).setAllowedOrigins),
      'undefined',
      'the session holds the client, never its control facet',
    );

    // The retained record is plain and reconstructible.
    t.deepEqual(session.persistence.policy.http, {
      allowedOrigins: [endpoint.origin],
      maxRequestsPerMinute: 30,
      maxResponseBytes: 1024 * 1024,
      policyMode: 'strict',
    });
  },
);
