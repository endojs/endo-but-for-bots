// @ts-check

// `issueGuestBootstrapPath` against fake daemons served on a real socket:
// support is read from the bootstrap's method names, never from error text.

import test from '@endo/ses-ava/prepare-endo.js';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeNetworkPowers } from '@endo/daemon/src/manager-node-powers.js';

import { issueGuestBootstrapPath } from '../src/server.js';

const FORMULA_ID = 'ab'.repeat(32);

let nextSocket = 0;

/**
 * Serve `methods` as the root bootstrap and return the `where` powers that
 * name its socket.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const serveFakeDaemon = async (t, methods) => {
  const socketPath = path.join(
    os.tmpdir(),
    `endo-issue-${process.pid.toString(36)}-${nextSocket}.sock`,
  );
  nextSocket += 1;
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  cancelled.catch(() => {});
  const bootstrap = makeExo(
    'Endo',
    M.interface('Endo', {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );
  const { makePrivatePathService } = makeNetworkPowers({ net, fsp });
  const { started, stopped } = makePrivatePathService(
    /** @type {any} */ (bootstrap),
    socketPath,
    cancelled,
    () => {},
  );
  stopped.catch(() => {});
  await started;
  t.teardown(() => cancel(Error('teardown')));
  return {
    env: { ENDO_SOCK: socketPath },
    platform: process.platform,
    info: { user: 'u', home: os.homedir(), temp: os.tmpdir() },
  };
};

test('a daemon without guestBootstrapPath is unsupported, not an error', async t => {
  const where = await serveFakeDaemon(t, { ping: () => 'pong' });
  t.is(
    await issueGuestBootstrapPath({ formulaId: FORMULA_ID, ...where }),
    undefined,
  );
});

test('a daemon that serves no guest sockets answers undefined', async t => {
  const where = await serveFakeDaemon(t, {
    guestBootstrapPath: () => undefined,
  });
  t.is(
    await issueGuestBootstrapPath({ formulaId: FORMULA_ID, ...where }),
    undefined,
  );
});

test('a daemon that serves guest sockets returns the issued path', async t => {
  /** @type {string[]} */
  const asked = [];
  const where = await serveFakeDaemon(t, {
    guestBootstrapPath: id => {
      asked.push(id);
      return '/run/guests/abab.sock';
    },
  });
  t.is(
    await issueGuestBootstrapPath({ formulaId: FORMULA_ID, ...where }),
    '/run/guests/abab.sock',
  );
  t.deepEqual(asked, [FORMULA_ID]);
});

test('a refusal from a supporting daemon rejects', async t => {
  const where = await serveFakeDaemon(t, {
    guestBootstrapPath: () => {
      throw Error('Formula is not a local guest');
    },
  });
  await t.throwsAsync(
    issueGuestBootstrapPath({ formulaId: FORMULA_ID, ...where }),
    { message: /is not a local guest/ },
  );
});
