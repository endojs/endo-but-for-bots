// @ts-check

// `makeGuestPathIssuer` in isolation: socket naming, path-length and
// name-collision refusals, idempotent reissue, and retry after a failed issue.

// Establish a perimeter:
import '@endo/init/debug.js';

import test from 'ava';
import { makeGuestPathIssuer } from '../src/serve-guest-path.js';

const numberA = 'a'.repeat(64);
const numberB = `${'a'.repeat(24)}${'b'.repeat(40)}`;
const numberC = 'c'.repeat(64);

// A listener that never accepts a connection.
const noConnections = async () => [];

/**
 * @param {object} [options]
 * @param {string} [options.directory]
 * @param {(path: string) => Promise<unknown>} [options.servePath]
 */
const makeHarness = ({
  directory = '/run/guests',
  servePath = noConnections,
} = {}) => {
  /** @type {string[]} */
  const served = [];
  /** @type {string[]} */
  const madeDirectories = [];
  /** @type {Error[]} */
  const reported = [];
  const cancelled = /** @type {Promise<never>} */ (new Promise(() => {}));
  const issuer = makeGuestPathIssuer({
    directory,
    socketPathFor: name => `${directory}/${name}`,
    makePrivateDirectory: async dir => {
      madeDirectories.push(dir);
    },
    servePath: /** @type {any} */ (
      async (/** @type {{ path: string }} */ { path }) => {
        served.push(path);
        return servePath(path);
      }
    ),
    cancelled,
    reportError: error => {
      reported.push(error);
    },
  });
  return { issuer, served, madeDirectories, reported };
};

test('a guest socket is named by a prefix of its formula number', async t => {
  const { issuer, served, madeDirectories } = makeHarness();
  const sockPath = await issuer.issue(numberA, {});
  t.is(sockPath, `/run/guests/${'a'.repeat(24)}.sock`);
  t.deepEqual(served, [sockPath]);
  t.deepEqual(madeDirectories, ['/run/guests']);
});

test('issuing again for the same guest returns the same path', async t => {
  const { issuer, served } = makeHarness();
  const first = issuer.issue(numberA, {});
  const second = issuer.issue(numberA, {});
  t.is(first, second);
  const [firstPath, secondPath] = await Promise.all([first, second]);
  t.is(firstPath, secondPath);
  t.is(served.length, 1);
});

test('the private directory is made once across guests', async t => {
  const { issuer, madeDirectories } = makeHarness();
  await Promise.all([issuer.issue(numberA, {}), issuer.issue(numberC, {})]);
  t.deepEqual(madeDirectories, ['/run/guests']);
});

test('two guests whose numbers share the socket-name prefix are refused', async t => {
  const { issuer } = makeHarness();
  await issuer.issue(numberA, {});
  t.throws(() => issuer.issue(numberB, {}), {
    message: /is already issued to another guest/,
  });
});

test('a socket path too long for a Unix socket is refused', t => {
  const { issuer, served } = makeHarness({ directory: `/${'d'.repeat(80)}` });
  t.throws(() => issuer.issue(numberA, {}), {
    message: /too long for a Unix socket/,
  });
  t.deepEqual(served, []);
});

test('a failed issue releases its name so it may be retried', async t => {
  let fail = true;
  const { issuer, served } = makeHarness({
    servePath: async () => {
      if (fail) {
        throw Error('address in use');
      }
      return noConnections();
    },
  });
  await t.throwsAsync(() => issuer.issue(numberA, {}), {
    message: /address in use/,
  });
  // The failed issue no longer holds the shared prefix either.
  fail = false;
  const sockPath = await issuer.issue(numberB, {});
  t.is(sockPath, `/run/guests/${'a'.repeat(24)}.sock`);
  t.is(served.length, 2);
});
