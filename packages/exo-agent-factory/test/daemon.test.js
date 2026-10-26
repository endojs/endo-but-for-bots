// @ts-nocheck

// The coordinator against a real Endo daemon, for the recovery-matrix rows
// that only a daemon restart can exercise: revival through the pinned
// coordinator with no holder call and no mail, a child that clears its own
// `@pins`, durable facets, and a revoked facet after restart.
//
// Daemon tests are serial because each one forks a full daemon process.

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, restart, purge, makeEndoClient } from '@endo/daemon';

import { installChildAgentFactory, LIFECYCLE_NAME } from '../index.js';

const makerSpecifier = new URL('./_daemon-maker.js', import.meta.url).href;

const rootPolicy = {
  maxChildren: 4,
  maxInstructionBytes: 1024,
  endowmentNames: ['notes'],
};

// Under the system temporary directory: a Unix-domain socket path is bounded
// (104 bytes on macOS), and a deep checkout overruns it.
const makeConfig = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eaf-'));
  return {
    base,
    statePath: path.join(base, 'state'),
    ephemeralStatePath: path.join(base, 'run'),
    cachePath: path.join(base, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? `\\\\?\\pipe\\exo-agent-factory-${path.basename(base)}.sock`
        : path.join(base, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const connect = async (t, config) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  t.teardown(() => cancel(new Error('test teardown')));
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  return E(getBootstrap()).host();
};

const prepare = async t => {
  const config = makeConfig();
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    fs.rmSync(config.base, { recursive: true, force: true });
  });
  const host = await connect(t, config);
  await E(host).makeUnconfined(undefined, makerSpecifier, {
    powersName: '@none',
    resultName: 'maker',
  });
  const root = await installChildAgentFactory(host, { rootPolicy });
  const forUi = await E(root).bind(await E(host).lookup('maker'));
  await E(host).storeValue(forUi, 'child-agents');
  return { config, host, root, forUi };
};

/**
 * Poll until `probe` returns a value other than `undefined`.
 *
 * @template T
 * @param {() => Promise<T | undefined>} probe
 * @param {string} what
 * @returns {Promise<T>}
 */
const eventually = async (probe, what) => {
  await null;
  const deadline = Date.now() + 30_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

// The private names of the factory's pieces of one child.
const piecesOf = async (host, suffix) => {
  const names = await E(host).list('agent-factory');
  return names.filter(name => /^c\d/.test(name) && name.endsWith(suffix));
};

// The runner's nonce for this incarnation, once it has activated.
const aliveNonce = async (host, driverName) => {
  const alive = await E(host).lookup(['agent-factory', driverName, 'alive']);
  return alive.incarnation;
};

// Wait for a runner incarnation other than `previous`.
const nextIncarnation = (host, driverName, previous) =>
  eventually(async () => {
    const nonce = await aliveNonce(host, driverName);
    return nonce === previous ? undefined : nonce;
  }, 'the runner to activate');

// Mail the child and wait for its runner's echo in the host's inbox.
const roundTrip = async (host, petName, text) => {
  await E(host).send(petName, [text], [], []);
  return eventually(async () => {
    const messages = await E(host).listMessages();
    const reply = messages.find(
      message =>
        message.type === 'package' &&
        message.strings.join('') === `echo: ${text}`,
    );
    return reply && reply.strings.join('');
  }, `an echo of ${text}`);
};

test.serial(
  'a committed child resumes after restart through the pinned coordinator, and its facets work without being re-issued',
  async t => {
    const { config, host, forUi } = await prepare(t);
    const { summary, handle } = await E(forUi).create('helper', {
      instructions: 'Echo.',
    });
    t.is(summary.phase, 'Committed');
    const [driverName] = await piecesOf(host, '.driver');
    const [responderName] = await piecesOf(host, '.responder');
    const before = await nextIncarnation(host, driverName, undefined);

    // The runner at the derived name is the coordinator's own unconfined
    // formula over the recorded driver guest, which is what a replay proves.
    const diagnostics = E(host).diagnostics();
    const record = await E(diagnostics).getFormula(
      await E(host).identify('agent-factory', responderName),
    );
    t.is(record.type, 'make-unconfined');
    t.is(
      record.properties.powers.identifier,
      await E(host).identify('agent-factory', driverName),
    );
    t.deepEqual(await E(host).list('@pins'), ['agent-factory']);

    await E(host).storeValue(handle, 'helper');
    t.is(await roundTrip(host, 'helper', 'one'), 'echo: one');

    await restart(config);
    const host2 = await connect(t, config);
    // Nothing calls a facet or sends mail: the pinned coordinator revives
    // the runner by itself. Reading the runner's nonce reaches only the
    // driver guest's directory, which revives nothing.
    const after = await nextIncarnation(host2, driverName, before);
    t.not(after, before);

    // The holder's facet is the same durable formula, re-derived from the
    // live coordinator.
    const forUi2 = await E(host2).lookup('child-agents');
    t.deepEqual(
      (await E(forUi2).list()).map(({ name, phase }) => ({ name, phase })),
      [{ name: 'helper', phase: 'Committed' }],
    );
    t.is(await E(forUi2).lookup('helper'), await E(host2).lookup('helper'));
    await E(forUi2).create('second');
    // The revived runner's lifecycle facet is a durable formula too.
    const lifecycle = await E(host2).lookup([
      'agent-factory',
      driverName,
      LIFECYCLE_NAME,
    ]);
    t.true(await E(lifecycle).isActive());
    t.is(await roundTrip(host2, 'helper', 'two'), 'echo: two');

    // Re-running the installer converges on the same root.
    const root2 = await installChildAgentFactory(host2, { rootPolicy });
    t.deepEqual(
      (await E(root2).listDerived()).map(
        ({ retainedChildren }) => retainedChildren,
      ),
      [2],
    );
  },
);

test.serial(
  'a child that replaces every entry of its own @pins still resumes and answers mail',
  async t => {
    const { config, host, forUi } = await prepare(t);
    const { handle } = await E(forUi).create('helper');
    await E(host).storeValue(handle, 'helper');
    const [guestName] = await piecesOf(host, '.guest');
    const [driverName] = await piecesOf(host, '.driver');
    const before = await nextIncarnation(host, driverName, undefined);

    // The child does what it likes with its own pins.
    const child = await E(host).lookup(['agent-factory', guestName]);
    await E(child).storeValue(harden({ junk: true }), ['@pins', 'junk']);
    for (const name of await E(child).list('@pins')) {
      // eslint-disable-next-line no-await-in-loop
      await E(child).remove('@pins', name);
    }
    t.deepEqual(await E(child).list('@pins'), []);

    await restart(config);
    const host2 = await connect(t, config);
    t.not(await nextIncarnation(host2, driverName, before), before);
    t.is(await roundTrip(host2, 'helper', 'still here'), 'echo: still here');
  },
);

test.serial('a revoked facet rejects every call after restart', async t => {
  const { config, host, forUi } = await prepare(t);
  const derived = await E(forUi).attenuate('sub', { maxChildren: 2 });
  await E(host).storeValue(derived, 'sub-agents');
  await E(derived).create('a');
  t.is((await piecesOf(host, '.guest')).length, 1);
  await E(forUi).revokeDerived('sub');
  await t.throwsAsync(E(derived).list(), { message: /revoked/ });
  t.deepEqual(await piecesOf(host, '.guest'), []);

  await restart(config);
  const host2 = await connect(t, config);
  const derived2 = await E(host2).lookup('sub-agents');
  await t.throwsAsync(E(derived2).list(), { message: /revoked/ });
  await t.throwsAsync(E(derived2).create('b'), { message: /revoked/ });
  await t.throwsAsync(E(derived2).attenuate('deeper', {}), {
    message: /revoked/,
  });
  const forUi2 = await E(host2).lookup('child-agents');
  t.deepEqual(await E(forUi2).listDerived(), []);
  t.deepEqual(await E(forUi2).list(), []);
});

test.serial(
  'removal leaves no responder, driver, guest, or retained endowment, and stays removed after restart',
  async t => {
    const { config, host, forUi } = await prepare(t);
    await E(host).makeUnconfined(undefined, makerSpecifier, {
      powersName: '@none',
      resultName: 'notes',
    });
    const notes = await E(host).lookup('notes');
    await E(forUi).create('helper', { endowments: { notes } });
    const [guestName] = await piecesOf(host, '.guest');
    // The child binds the very formula the creator passed.
    t.is(
      await E(host).identify('agent-factory', guestName, 'notes'),
      await E(host).identify('agent-factory', 'c1.0.e0'),
    );
    await E(forUi).remove('helper');
    t.deepEqual(
      (await E(host).list('agent-factory')).filter(name => /^c\d/.test(name)),
      [],
    );
    t.deepEqual(await E(forUi).list(), []);

    await restart(config);
    const host2 = await connect(t, config);
    const forUi2 = await E(host2).lookup('child-agents');
    t.deepEqual(await E(forUi2).list(), []);
    await E(forUi2).create('helper');
    t.is((await piecesOf(host2, '.guest')).length, 1);
  },
);
