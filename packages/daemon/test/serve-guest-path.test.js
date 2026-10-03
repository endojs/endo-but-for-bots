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
 * @param {(path: string, cancelled: Promise<never>) => Promise<unknown>} [options.servePath]
 * @param {(directory: string) => Promise<void>} [options.makePrivateDirectory]
 * @param {Promise<never>} [options.cancelled] - the daemon's cancellation.
 */
const makeHarness = ({
  directory = '/run/guests',
  servePath = noConnections,
  makePrivateDirectory = async () => {},
  cancelled = /** @type {Promise<never>} */ (new Promise(() => {})),
} = {}) => {
  /** @type {string[]} */
  const served = [];
  /** @type {string[]} */
  const madeDirectories = [];
  /** @type {Error[]} */
  const reported = [];
  /** @type {Promise<never>[]} */
  const cancellations = [];
  const issuer = makeGuestPathIssuer({
    directory,
    socketPathFor: name => `${directory}/${name}`,
    makePrivateDirectory: async privateDirectory => {
      madeDirectories.push(privateDirectory);
      return makePrivateDirectory(privateDirectory);
    },
    servePath: /** @type {any} */ (
      async (
        /** @type {{ path: string, cancelled: Promise<never> }} */ {
          path,
          cancelled: serviceCancelled,
        },
      ) => {
        served.push(path);
        cancellations.push(serviceCancelled);
        return servePath(path, serviceCancelled);
      }
    ),
    cancelled,
    reportError: error => {
      reported.push(error);
    },
  });
  return { issuer, served, madeDirectories, reported, cancellations };
};

test('a guest socket is named by a prefix of its formula number', async t => {
  const { issuer, served, madeDirectories } = makeHarness();
  const socketPath = await issuer.issue(numberA, {});
  t.is(socketPath, `/run/guests/${'a'.repeat(24)}.sock`);
  t.deepEqual(served, [socketPath]);
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

test('a socket path at the Unix socket limit is served', async t => {
  // A 73-character directory, a slash, and a 29-character name: 103.
  const directory = `/${'d'.repeat(72)}`;
  const { issuer } = makeHarness({ directory });
  const socketPath = await issuer.issue(numberA, {});
  t.is(socketPath.length, 103);
});

test('a socket path one past the Unix socket limit is refused', t => {
  const directory = `/${'d'.repeat(73)}`;
  const { issuer, served } = makeHarness({ directory });
  t.throws(() => issuer.issue(numberA, {}), {
    message: /too long for a Unix socket/,
  });
  t.deepEqual(served, []);
});

test('a failed private directory is made again by the next issue', async t => {
  let fail = true;
  const { issuer, madeDirectories, served } = makeHarness({
    makePrivateDirectory: async () => {
      if (fail) {
        throw Error('no space left on device');
      }
    },
  });
  await t.throwsAsync(() => issuer.issue(numberA, {}), {
    message: /no space left on device/,
  });
  fail = false;
  // A different guest is not wedged by the first guest's failure.
  const socketPath = await issuer.issue(numberC, {});
  t.is(socketPath, `/run/guests/${'c'.repeat(24)}.sock`);
  t.deepEqual(madeDirectories, ['/run/guests', '/run/guests']);
  t.deepEqual(served, [socketPath]);
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
  const socketPath = await issuer.issue(numberB, {});
  t.is(socketPath, `/run/guests/${'a'.repeat(24)}.sock`);
  t.is(served.length, 2);
});

test('revoking a guest cancels its socket service with the reason', async t => {
  const { issuer, cancellations, reported } = makeHarness();
  await issuer.issue(numberA, {});
  await issuer.issue(numberC, {});
  const reason = Error('collected');
  issuer.revoke(numberA, reason);
  await t.throwsAsync(cancellations[0], { is: reason });
  // The other guest's service is untouched.
  const pending = Symbol('pending');
  t.is(await Promise.race([cancellations[1], pending]), pending);
  // A revocation is a deliberate stop, not an error to report.
  await null;
  t.deepEqual(reported, []);
});

test('a revoked guest no longer holds its socket name', async t => {
  const { issuer, served } = makeHarness();
  const first = await issuer.issue(numberA, {});
  issuer.revoke(numberA, Error('collected'));
  // The shared prefix is free for another guest after revocation.
  t.is(await issuer.issue(numberB, {}), first);
  t.is(served.length, 2);
});

test('revoking a guest that holds no socket does nothing', t => {
  const { issuer } = makeHarness();
  t.notThrows(() => issuer.revoke(numberA, Error('collected')));
});

// A listener whose connection stream ends with its service's cancellation, as
// a real listener's does.
/**
 * @param {string} _path
 * @param {Promise<never>} serviceCancelled
 */
const endsWithCancellation = async (_path, serviceCancelled) => ({
  [Symbol.asyncIterator]: () => ({ next: () => serviceCancelled }),
});

test('daemon cancellation stops guest sockets without reporting an error', async t => {
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  const cancelled = /** @type {Promise<never>} */ (
    new Promise((_resolve, reject) => {
      cancel = reject;
    })
  );
  const { issuer, cancellations, reported } = makeHarness({
    servePath: endsWithCancellation,
    cancelled,
  });
  await issuer.issue(numberA, {});
  await issuer.issue(numberC, {});
  const reason = Error('daemon stopping');
  cancel(reason);
  await t.throwsAsync(cancellations[0], { is: reason });
  await t.throwsAsync(cancellations[1], { is: reason });
  await new Promise(resolve => setTimeout(resolve, 0));
  t.deepEqual(reported, []);
});

test('a guest socket that fails while serving reports the error', async t => {
  const failure = Error('listener failed');
  const { issuer, reported } = makeHarness({
    servePath: async () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    }),
  });
  await issuer.issue(numberA, {});
  await new Promise(resolve => setTimeout(resolve, 0));
  t.deepEqual(reported, [failure]);
});
