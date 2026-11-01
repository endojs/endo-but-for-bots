// @ts-nocheck

// The coordinator against a real Endo daemon, for the recovery-matrix rows
// that only a daemon restart can exercise: revival through the pinned
// coordinator with no holder call and no mail, a child that clears its own
// `@pins`, durable facets, a revoked facet after restart, removal and
// revocation interrupted by a crash, and the turn-ledger crash cut inside
// `infer` after a tool effect.
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

const inferenceMakerSpecifier = new URL(
  './_daemon-inference-maker.js',
  import.meta.url,
).href;

// The parent's view of the replies its child published, by answered message.
const repliesFrom = async (host, sentText) => {
  const messages = await E(host).listMessages();
  const asked = messages.find(
    message =>
      message.type === 'package' && message.strings.join('') === sentText,
  );
  if (!asked) return [];
  return messages
    .filter(
      message =>
        message.type === 'package' && message.replyTo === asked.messageId,
    )
    .map(message => message.strings.join(''));
};

test.serial(
  'an inference-backed child journals its turns and does not re-infer after restart',
  async t => {
    const { config, host, root } = await prepare(t);
    await E(host).makeUnconfined(undefined, inferenceMakerSpecifier, {
      powersName: '@none',
      resultName: 'inference-maker',
    });
    const forInference = await E(root).bind(
      await E(host).lookup('inference-maker'),
    );
    await E(host).storeValue(forInference, 'inference-agents');
    const { handle } = await E(forInference).create('thinker', {
      instructions: 'Answer.',
    });
    await E(host).storeValue(handle, 'thinker');

    await E(host).send('thinker', ['first'], [], []);
    const first = await eventually(
      () => repliesFrom(host, 'first').then(replies => replies[0]),
      'a reply to the first message',
    );
    t.regex(first, /^answer 1 from .* to Answer\.\n\nfirst$/);

    // The runner journals the answered turn in its driver guest.
    const [driverName] = await piecesOf(host, '.driver');
    const ledger = (await E(host).list('agent-factory', driverName)).filter(
      name => name.startsWith('turn-'),
    );
    const [resultName] = ledger.filter(name => name.endsWith('-result'));
    const stem = resultName.slice(0, -'-result'.length);
    t.deepEqual(
      ledger.sort(),
      [
        `${stem}-published`,
        `${stem}-result`,
        `${stem}-started`,
        'turn-cursor',
      ].sort(),
    );
    const result = await E(host).lookup([
      'agent-factory',
      driverName,
      resultName,
    ]);
    t.is(result.type, 'TurnResult');
    t.is(result.result.text, first);

    await restart(config);
    const host2 = await connect(t, config);
    await E(host2).send('thinker', ['second'], [], []);
    const second = await eventually(
      () => repliesFrom(host2, 'second').then(replies => replies[0]),
      'a reply to the second message',
    );
    // A fresh backend incarnation answers the new turn as its first call; the
    // published turn was neither re-inferred nor republished.
    t.regex(second, /^answer 1 from .* to Answer\.\n\nsecond$/);
    t.not(second.split(' ')[3], first.split(' ')[3]);
    t.deepEqual(await repliesFrom(host2, 'first'), [first]);
  },
);

const crashMakerSpecifier = new URL('./_daemon-crash-maker.js', import.meta.url)
  .href;

// The prompts the crash maker's fake backend has acted on, one per effect.
const effectsIn = effectsPath =>
  fs.existsSync(effectsPath)
    ? fs.readFileSync(effectsPath, 'utf8').split('\n').filter(Boolean)
    : [];

test.serial(
  'a crash inside infer after a tool effect re-runs the turn once and publishes one reply',
  async t => {
    const { config, host, root } = await prepare(t);
    const effectsPath = path.join(config.base, 'effects');
    const holdPath = path.join(config.base, 'hold');
    fs.writeFileSync(holdPath, '');
    await E(host).makeUnconfined(undefined, crashMakerSpecifier, {
      powersName: '@none',
      resultName: 'crash-maker',
      env: { EFFECTS_PATH: effectsPath, HOLD_PATH: holdPath },
    });
    const forCrash = await E(root).bind(await E(host).lookup('crash-maker'));
    const { handle } = await E(forCrash).create('worker');
    await E(host).storeValue(handle, 'worker');
    const [driverName] = await piecesOf(host, '.driver');

    await E(host).send('worker', ['act'], [], []);
    await eventually(
      async () => (effectsIn(effectsPath).length === 1 ? true : undefined),
      'the tool effect of the held turn',
    );
    // The turn started and its effect happened, but `infer` has not
    // returned, so the ledger holds no result and nothing was published.
    const heldLedger = (await E(host).list('agent-factory', driverName)).filter(
      name => name.startsWith('turn-'),
    );
    t.is(heldLedger.length, 1);
    t.regex(heldLedger[0], /-started$/);
    t.deepEqual(await repliesFrom(host, 'act'), []);

    fs.rmSync(holdPath);
    await restart(config);
    const host2 = await connect(t, config);
    const reply = await eventually(
      () => repliesFrom(host2, 'act').then(replies => replies[0]),
      'the reply to the held turn',
    );
    t.is(reply, 'done: act');
    // No result was recorded before the crash, so the revived runner called
    // `infer` again and the tool effect happened twice.
    t.deepEqual(effectsIn(effectsPath), ['act', 'act']);

    // Once the result is recorded the turn is never inferred again: another
    // restart and a new message add one effect, for the new message only.
    await restart(config);
    const host3 = await connect(t, config);
    await E(host3).send('worker', ['again'], [], []);
    await eventually(
      () => repliesFrom(host3, 'again').then(replies => replies[0]),
      'the reply to the second message',
    );
    t.deepEqual(effectsIn(effectsPath), ['act', 'act', 'again']);
    t.deepEqual(await repliesFrom(host3, 'act'), ['done: act']);
  },
);

// A crash between two journal appends leaves the private directory exactly as
// if the record were appended and the daemon then stopped. Write that record
// at the namespace's next sequence number, then restart: the revived
// coordinator must converge from it with no holder call.
const crashAfterAppending = async (host, config, nsId, entry) => {
  await null;
  const sequences = (await E(host).list('agent-factory'))
    .map(name => /^j(\d+)\.(\d+)$/.exec(name))
    .filter(match => match && Number(match[1]) === nsId)
    .map(match => Number(match[2]));
  const next = Math.max(-1, ...sequences) + 1;
  await E(host).storeValue(harden(entry), [
    'agent-factory',
    `j${nsId}.${next}`,
  ]);
  await restart(config);
};

const namespaceOf = operationId => Number(operationId.split('.')[0]);

test.serial(
  'a crash after Removing is journaled converges to Removed, and the revived lifecycle is inactive',
  async t => {
    const { config, host, forUi } = await prepare(t);
    const { summary, handle } = await E(forUi).create('helper');
    await E(host).storeValue(handle, 'helper');
    t.is(await roundTrip(host, 'helper', 'one'), 'echo: one');
    const { operationId } = summary;

    await crashAfterAppending(host, config, namespaceOf(operationId), {
      type: 'Removing',
      op: operationId,
    });
    const host2 = await connect(t, config);
    const forUi2 = await E(host2).lookup('child-agents');

    // Reconciliation finishes the removal by itself: the name stays
    // reserved until then and is released after, with every piece gone.
    await eventually(async () => {
      const children = await E(forUi2).list();
      return children.length === 0 ? true : undefined;
    }, 'the interrupted removal to converge');
    t.deepEqual(await piecesOf(host2, '.guest'), []);
    t.deepEqual(await piecesOf(host2, '.driver'), []);
    t.deepEqual(await piecesOf(host2, '.responder'), []);
    await t.throwsAsync(E(forUi2).lookup('helper'));

    // The lifecycle a stale formula would re-derive from the live
    // coordinator is inactive, so a runner revived from it never opens its
    // follower.
    const coordinator = await E(host2).lookup(['agent-factory', 'coordinator']);
    const lifecycle = await E(coordinator).lifecycleFor(operationId);
    t.false(await E(lifecycle).isActive());
    t.deepEqual(await E(coordinator).faults(), {});

    // The name and its quota slot are free again.
    const { handle: again } = await E(forUi2).create('helper');
    await E(host2).storeValue(again, 'helper-again');
    t.is(await roundTrip(host2, 'helper-again', 'two'), 'echo: two');
  },
);

test.serial(
  'a crash after Revoking is journaled converges to Revoked across nested namespaces and releases quota',
  async t => {
    const { config, host, forUi } = await prepare(t);
    const derived = await E(forUi).attenuate('sub', { maxChildren: 3 });
    await E(host).storeValue(derived, 'sub-agents');
    const deeper = await E(derived).attenuate('deeper', { maxChildren: 1 });
    await E(host).storeValue(deeper, 'deeper-agents');
    const { summary: subChild } = await E(derived).create('a');
    await E(derived).create('b');
    const { summary: deeperChild } = await E(deeper).create('c');
    t.is((await piecesOf(host, '.guest')).length, 3);
    // The root's quota of four already counts all three descendants.
    await E(forUi).create('top');
    await t.throwsAsync(E(forUi).create('over'), { message: /quota/ });

    await crashAfterAppending(host, config, namespaceOf(subChild.operationId), {
      type: 'Revoking',
    });
    const host2 = await connect(t, config);
    const forUi2 = await E(host2).lookup('child-agents');

    await eventually(async () => {
      const derivedList = await E(forUi2).listDerived();
      return derivedList.length === 0 ? true : undefined;
    }, 'the interrupted revocation to converge');
    const derived2 = await E(host2).lookup('sub-agents');
    const deeper2 = await E(host2).lookup('deeper-agents');
    for (const facet of [derived2, deeper2]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(E(facet).list(), { message: /revoked/ });
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(E(facet).create('x'), { message: /revoked/ });
    }

    // Only the root's own child survives, and every descendant's lifecycle
    // is inactive.
    t.is((await piecesOf(host2, '.guest')).length, 1);
    t.deepEqual(
      (await E(forUi2).list()).map(({ name }) => name),
      ['top'],
    );
    const coordinator = await E(host2).lookup(['agent-factory', 'coordinator']);
    for (const operationId of [subChild.operationId, deeperChild.operationId]) {
      // eslint-disable-next-line no-await-in-loop
      const lifecycle = await E(coordinator).lifecycleFor(operationId);
      // eslint-disable-next-line no-await-in-loop
      t.false(await E(lifecycle).isActive());
    }

    // Every ancestor quota slot is released.
    await E(forUi2).create('one');
    await E(forUi2).create('two');
    await E(forUi2).create('three');
    await t.throwsAsync(E(forUi2).create('four'), { message: /quota/ });
  },
);
