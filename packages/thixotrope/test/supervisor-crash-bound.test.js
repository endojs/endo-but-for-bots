// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { WorkerCrashError } from '../src/core/worker-crash-error.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

/** @import { ExecutionContext } from 'ava' */

const nodePowers = makeNodePowers();
const SETTING = 'THIXOTROPE_MAX_DELIVERY_ATTEMPTS';

/**
 * Powers whose environment holds the setting as given, whatever the
 * environment these tests are run in holds.
 *
 * @param {string | undefined} text
 */
const powersWithSetting = text => ({
  ...nodePowers,
  environment: {
    ...nodePowers.environment,
    /** @param {string} name */
    get: name => (name === SETTING ? text : nodePowers.environment.get(name)),
  },
});

/**
 * An engine whose workspace vat crashes on every frame while `crashing`.
 */
const makeCrashableEngine = () => {
  const replay = makePeerJournalReplayEngine(nodePowers);
  const control = { crashing: false, crashes: 0 };
  const engine = harden({
    ...replay,
    acquireStore: async () => async () => {},
    /** @param {any} options */
    start: async options => {
      const incarnation = await replay.start(options);
      return harden({
        ...incarnation,
        /** @param {any} message */
        deliver: async message => {
          if (
            control.crashing &&
            message.t === 'f' &&
            options.debugName.startsWith('workspace:')
          ) {
            control.crashes += 1;
            throw new WorkerCrashError('injected worker exit');
          }
          return incarnation.deliver(message);
        },
      });
    },
  });
  return { engine, control };
};

/**
 * @param {ExecutionContext} t
 * @param {string} root
 * @param {ReturnType<typeof makeCrashableEngine>['engine']} engine
 * @param {string | undefined} setting
 * @param {number} crashRetryDelayMs
 */
const serve = async (t, root, engine, setting, crashRetryDelayMs) => {
  const supervisor = await serveThixotrope(powersWithSetting(setting), root, {
    crashRetryDelayMs,
    engine,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await supervisor.close();
  };
  t.teardown(close);
  const client = await connectLocalControl(
    nodePowers,
    join(root, 'control.sock'),
  );
  t.teardown(() => client.close());
  return { client, close };
};

/** @param {{ call: (method: string) => Promise<any> }} client */
const failedWorkers = async client => {
  const { workers } = await client.call('status');
  return workers.filter(
    (/** @type {any} */ worker) => worker.failure !== undefined,
  );
};

for (const [setting, bound] of /** @type {const} */ ([
  [undefined, 5],
  ['2', 2],
  ['7', 7],
])) {
  test.serial(
    `the supervisor gives up on a vat after ${bound} crashes without progress when the setting is ${setting ?? 'absent'}`,
    async t => {
      t.timeout(60_000);
      const root = await mkdtemp('/tmp/thix-crash-bound-');
      t.teardown(() => rm(root, { recursive: true, force: true }));
      const { engine, control } = makeCrashableEngine();
      const { client } = await serve(t, root, engine, setting, 1);
      t.is(await client.call('evaluate', '1 + 1'), '2');

      control.crashing = true;
      // The pending call is not left to hang: giving the vat up retires its
      // session.
      await t.throwsAsync(() => client.call('evaluate', '2 + 2'), {
        message: /the target session has been retired/,
      });
      t.is(control.crashes, bound, 'that many attempts, then no more');
      control.crashing = false;
      const failed = await failedWorkers(client);
      t.is(failed.length, 1, 'the other vats are untouched');
      t.like(failed[0], { debugLabel: 'workspace:default', awake: false });
      t.is(
        failed[0].failure.replace(/journal frame \d+/, 'journal frame N'),
        `crashed ${bound} times without progress, last while replaying journal frame N: injected worker exit`,
      );
    },
  );
}

test.serial(
  'a supervisor starts although a vat is given up on during its startup replay',
  async t => {
    t.timeout(60_000);
    const root = await mkdtemp('/tmp/thix-crash-bound-');
    t.teardown(() => rm(root, { recursive: true, force: true }));
    const { engine, control } = makeCrashableEngine();
    const first = await serve(t, root, engine, undefined, 1);
    t.is(await first.client.call('evaluate', '1 + 1'), '2');
    await first.client.close();
    await first.close();

    // The workspace vat now crashes on its journal's replay. With the wait
    // between retries long enough for the rest of startup to overtake it,
    // startup must still find the vat in a settled state: a vat that looked
    // healthy and was then given up on mid-startup would reject the start.
    control.crashing = true;
    const second = await serve(t, root, engine, undefined, 50);
    t.is(control.crashes, 5);
    control.crashing = false;
    const failed = await failedWorkers(second.client);
    t.deepEqual(
      failed.map((/** @type {any} */ worker) => worker.debugLabel),
      ['workspace:default'],
    );
  },
);

test.serial(
  'a malformed attempt bound is refused before the state directory is touched',
  async t => {
    t.timeout(60_000);
    const base = await mkdtemp('/tmp/thix-crash-bound-');
    t.teardown(() => rm(base, { recursive: true, force: true }));
    const path = join(base, 'state');
    // One is refused with the rest: a vat given up on is not got back, and
    // a bound of one leaves no retry to tell a passing fault from a lasting
    // one.
    for (const text of ['0', '1', '-1', '3.5', 'three', '', '02', '101']) {
      // eslint-disable-next-line no-await-in-loop
      const error = await serveThixotrope(powersWithSetting(text), path).then(
        async supervisor => {
          await supervisor.close();
          return undefined;
        },
        reason => reason,
      );
      t.regex(
        String(error?.message),
        /THIXOTROPE_MAX_DELIVERY_ATTEMPTS must be a decimal integer between 2 and 100/,
        `refuses ${JSON.stringify(text)}`,
      );
    }
    await t.throwsAsync(() => stat(path), { code: 'ENOENT' });
  },
);
