// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import http from 'node:http';

import {
  approvedSpendCents,
  makePrivacyClient,
  makePrivacyProtocol,
} from '../src/client.js';
import { nodeFetch } from '../src/node-fetch.js';

test('the client requires an explicit fetch transport', t => {
  t.throws(() => makePrivacyClient(/** @type {any} */ ({ apiKey: 'k' })), {
    message: /explicit fetch transport/,
  });
});

test('error redaction tolerates a non-string server message', async t => {
  /** @type {import('../src/client.js').FetchLike} */
  const fetchFn = async () =>
    harden({
      ok: false,
      status: 500,
      json: async () => ({ message: 42 }),
    });
  const client = makePrivacyClient({ apiKey: 'secret-key', fetchFn });
  // The status context must survive; the coercion must not throw a
  // TypeError from .split on a number.
  await t.throwsAsync(() => client.status(), { message: /500/ });
});

test('listCardTransactions tolerates a bare-array response', async t => {
  const protocol = makePrivacyProtocol(async () =>
    harden([
      { amount: -1200, result: 'APPROVED', status: 'SETTLED' },
      { amount: -300, result: 'APPROVED', status: 'SETTLED' },
    ]),
  );
  const transactions = await protocol.listCardTransactions('card-1');
  // A silently-empty read here would under-report approved spend and
  // over-refund at closeCard.
  t.is(approvedSpendCents(transactions), 1500);
});

test('nodeFetch times out a server that never responds', async t => {
  const server = http.createServer(() => {
    // Accept the request and never reply.
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  t.teardown(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  );
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  // Without the timeout this hangs forever — and a hung request inside
  // the account mutex would deadlock every future budget mutation.
  await t.throwsAsync(
    () => nodeFetch(`http://127.0.0.1:${port}/v1/status`, { timeoutMs: 50 }),
    { message: /timed out/ },
  );
});
