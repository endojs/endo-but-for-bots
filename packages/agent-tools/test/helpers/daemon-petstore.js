// @ts-nocheck
/* global process */

// Real daemon-backed guest petstore harness for the capref tests.
//
// agent-tools resolves a capref-typed tool arg by sending
// `E(powers).lookup(petname)` against the guest's own petstore — exactly what
// every lal tool already does. The capref tests must exercise that live path,
// not a hand-rolled `Map`, so this helper spins up a real Endo daemon, takes a
// host, provisions a guest (the `powers` a tool closes over), and binds a
// formula-backed cap under a friendly petname the way a host does in
// production.
//
// It reuses the daemon's public `start` / `stop` / `purge` / `makeEndoClient`
// building blocks (the same set `@endo/endo-fs-exec`'s daemon test uses) rather
// than reaching into the daemon's private test harness. Daemon tests fork a
// full daemon per test and share filesystem state under `test/tmp`, so every
// caller runs `test.serial` and this helper registers a `t.teardown`.

import path from 'path';
import url from 'url';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));

let testCounter = 0;

/**
 * Build a fresh daemon config under `test/tmp/NNNN/`. Socket paths are kept
 * short because `sockaddr_un` bounds the Unix-domain socket path length
 * (~108 bytes on Linux).
 */
const makeConfig = () => {
  testCounter += 1;
  const tag = String(testCounter).padStart(4, '0');
  const base = path.join(dirname, '..', 'tmp', tag);
  return {
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\agent-tools-${tag}.sock`
        : path.join(base, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * Start a daemon, take a host, and provision a guest. The guest exo is the
 * `powers` a tool set closes over: it carries `lookup` (resolve a petname),
 * `storeIdentifier` / `storeValue` (host-side bind), and `evaluate` (mint a
 * formula-backed cap). Registers a teardown that stops the daemon.
 *
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<any>} the guest powers (an `EndoGuest` facet)
 */
export const prepareGuestPowers = async t => {
  const config = makeConfig();
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});

  await purge(config);
  await start(config);
  t.teardown(async () => {
    cancel(new Error('test teardown'));
    await stop(config).catch(() => {});
  });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});

  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();
  const guest = await E(host).provideGuest('agent-tools-test-guest');
  return guest;
};

/**
 * Mint a small formula-backed cap (a counter exo) inside the guest and bind it
 * under `petname`, the way a host binds a granted cap at provisioning. The cap
 * is evaluated in a guest worker so it has a daemon formula and therefore
 * resolves through `E(powers).lookup(petname)` like any granted capability.
 *
 * The counter's `incr()` lets a test prove the resolved value is the *live*
 * cap (it answers an eventual-send and advances shared state), not the petname
 * string.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {any} powers the guest from {@link prepareGuestPowers}
 * @param {string} petname
 * @returns {Promise<any>} the live cap, also reachable via `lookup(petname)`
 */
export const bindCap = async (t, powers, petname) => {
  // `evaluate(worker, source, codeNames, petNames, resultName)` formulates the
  // exo (auto-provisioning the named worker), stores it under `resultName`, and
  // returns the live value. Storing it under `petname` is the host-side bind;
  // the tool later resolves the same name via `lookup`.
  const cap = await E(powers).evaluate(
    'agent-tools-test-worker',
    `
      (() => {
        let value = 0;
        return makeExo(
          'Counter',
          M.interface('Counter', {}, { defaultGuards: 'passable' }),
          {
            incr: () => (value += 1),
            decr: () => (value -= 1),
          },
        );
      })();
    `,
    [],
    [],
    petname,
  );
  return cap;
};
