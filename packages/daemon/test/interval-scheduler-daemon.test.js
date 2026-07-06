// @ts-nocheck
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { start, stop, purge, makeEndoClient } from '../index.js';

// Exercises endoclaw-timer Phase 2 end to end against a real daemon: an
// interval scheduler delivers its ticks as `interval-tick` mail messages
// carrying a `tick-response` capability, and the agent drives the schedule by
// invoking that capability. The scheduler is bound to the host agent, so the
// host's own inbox receives the ticks.

const { raw } = String;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

// The unix domain socket path has a hard ~104-char limit on many platforms, so
// keep it short and out of the (potentially deep) worktree tree, while the
// bulkier state directories live under the package `tmp/`.
const shortSockPath = tag => {
  const base = process.env.TMPDIR || '/tmp';
  return process.platform === 'win32'
    ? raw`\\?\pipe\endo-${tag}-test.sock`
    : path.join(base, `endo-imt-${tag}.sock`);
};

const makeConfig = (...root) => {
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    sockPath: shortSockPath(root.join('-').replace(/[^a-z0-9]+/gi, '')),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const prepareConfig = async t => {
  const { cancelled, cancel } = makeCancelKit();
  const config = { ...makeConfig('tmp', `interval-mail~${t.context.length}`) };
  await purge(config);
  await start(config);
  const contextObj = { cancel, cancelled, config };
  t.context.push(contextObj);
  return { ...contextObj };
};

const prepareHost = async t => {
  const { cancel, cancelled, config } = await prepareConfig(t);
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { cancel, cancelled, config, host: E(bootstrap).host() };
};

/**
 * Advance an inbox iterator until the next `interval-tick` message, returning
 * it. Fails the test if a bounded number of non-tick messages arrive first.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {AsyncIterator<any>} iterator
 */
const takeNextTick = async (t, iterator) => {
  await null;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { value: message, done } = await iterator.next();
    t.false(done, 'inbox stream ended before a tick arrived');
    if (message.type === 'interval-tick') {
      return message;
    }
  }
  throw Error('no interval-tick message arrived');
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

test('interval scheduler delivers ticks as mail and resolve advances the schedule', async t => {
  const { host } = await prepareHost(t);

  // The host method resolves to the `{ scheduler, schedulerControl }` facet
  // pair (endoclaw-timer Phase 4); the agent-facing `scheduler` facet carries
  // makeInterval / list.
  const { scheduler } = await E(host).makeIntervalScheduler('scheduler', {
    minPeriodMs: 1000,
  });

  // Follow the host inbox before creating the interval so the immediate first
  // tick is observed.
  const iterator = iterateReader(E(host).followMessages());

  // firstDelayMs 0 → the first tick fires immediately; a generous
  // tickTimeoutMs keeps auto-resolve from racing the manual response.
  await E(scheduler).makeInterval('heartbeat', 1000, {
    firstDelayMs: 0,
    tickTimeoutMs: 60_000,
  });

  const tick1 = await takeNextTick(t, iterator);
  t.is(tick1.type, 'interval-tick', 'tick is delivered as an interval-tick');
  t.is(tick1.label, 'heartbeat');
  t.is(tick1.periodMs, 1000);
  t.is(tick1.tickNumber, 1, 'first tick is number 1');
  t.is(tick1.missedTicks, 0);
  t.is(typeof tick1.intervalId, 'string');
  t.is(
    typeof tick1.tickResponseId,
    'string',
    'tick carries a tick-response capability reference',
  );

  // Resolve the tick through the delivered capability; the schedule advances
  // and the next tick is delivered as another mail message.
  const tickResponse1 = await E(host).lookupByLocator(tick1.tickResponseId);
  await E(tickResponse1).resolve();

  const tick2 = await takeNextTick(t, iterator);
  t.is(tick2.tickNumber, 2, 'resolve() advanced the schedule to the next tick');
  t.is(tick2.intervalId, tick1.intervalId, 'same interval');
  t.not(
    tick2.tickResponseId,
    tick1.tickResponseId,
    'each tick carries a fresh tick-response',
  );

  // Clean up the interval so the scheduler's timers stop before teardown.
  const tickResponse2 = await E(host).lookupByLocator(tick2.tickResponseId);
  await E(tickResponse2).resolve();
});
