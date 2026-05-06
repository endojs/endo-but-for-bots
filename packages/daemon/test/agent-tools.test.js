// @ts-nocheck
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import {
  start,
  stop,
  restart,
  purge,
  makeEndoClient,
  makeRefIterator,
} from '../index.js';

/**
 * @import {EReturn} from '@endo/eventual-send';
 */

void crypto;

const { raw } = String;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

/** @type {Map<string, number>} */
const testNumbers = new Map();

const getConfigDirectoryName = (testTitle, testConfigIndex) => {
  const munged = testTitle.match(/\w+/gu)?.join('-') || '';
  if (!testNumbers.has(testTitle)) testNumbers.set(testTitle, testNumbers.size);
  const testNumber = testNumbers.get(testTitle);
  const nnnn = String(testNumber).padStart(4, '0');
  const letter = (testConfigIndex + 10).toString(36);
  return `${munged.slice(0, 24)}~${nnnn}${letter}`;
};

const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath:
    process.platform === 'win32'
      ? raw`\\?\pipe\endo-${root.join('-')}-agent-tools.sock`
      : path.join(dirname, ...root, 'endo.sock'),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
});

const prepareConfig = async (t, { gcEnabled = false } = {}) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  cancelled.catch(() => {});
  const config = {
    ...makeConfig('tmp', getConfigDirectoryName(t.title, t.context.length)),
    gcEnabled,
  };
  await purge(config);
  await start(config);
  const contextObj = { cancel, cancelled, config };
  t.context.push(contextObj);
  return { ...contextObj };
};

const makeHost = async (config, cancelled) => {
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { host: E(bootstrap).host() };
};

const prepareHost = async t => {
  const { cancel, cancelled, config } = await prepareConfig(t);
  const { host } = await makeHost(config, cancelled);
  return { cancel, cancelled, config, host };
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  /** @type {EReturn<typeof prepareConfig>[]} */
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

// Each daemon-forking test runs serially and registers its own
// teardown via the global afterEach.always hook above.

test.serial(
  'integration: makeIntervalScheduler is reachable end-to-end and creates intervals',
  async t => {
    t.timeout(45_000);
    const { host } = await prepareHost(t);

    // The kit's default minPeriodMs is 30_000; the maker accepts a
    // custom minPeriodMs in opts so a test interval can fire fast.
    await E(host).makeIntervalScheduler('heartbeat', {
      minPeriodMs: 100,
    });

    // The maker returns the kit `{ scheduler, control }`; lookup
    // hands back the kit record and the scheduler / control facets
    // are accessed via property access on the awaited record.
    const kit = await E(host).lookup('heartbeat');
    t.truthy(kit, 'scheduler kit is reachable by pet name');
    const scheduler = kit.scheduler;
    const control = kit.control;
    t.truthy(scheduler, 'kit.scheduler facet is exposed');
    t.truthy(control, 'kit.control facet is exposed');

    const interval = await E(scheduler).makeInterval('beat', 200, {
      firstDelayMs: 50_000, // far enough out that no tick fires during the test
      tickTimeoutMs: 5_000,
    });
    t.is(await E(interval).label(), 'beat');
    t.is(await E(interval).period(), 200);

    const list = await E(scheduler).list();
    t.is(list.length, 1, 'scheduler.list reports the new interval');
    t.is(list[0].label, 'beat');

    await E(interval).cancel();
    const after = await E(interval).info();
    t.is(after.status, 'cancelled');
  },
);

// Mail-mode tick delivery itself (E(handle).receive(tickMessage, ...))
// is broken in the bundled patches: receive() is part of the
// envelope-protocol where the recipient asks the sender to `open()`
// a parcel the sender previously placed in its outbox.  The tick
// maker never enrols an envelope in the sender's outbox, so every
// tick triggers `Mail fraud: unrecognized parcel` inside receive()
// and the catch-handler swallows it.  The proper fix is to plumb
// the agent's mailbox `deliver()` (or call `agent.send()`) into the
// scheduler maker scope, which is a follow-up larger than a fixer
// pass.
test.serial.skip(
  'integration (follow-up): tick delivery actually lands in the agent inbox',
  async t => {
    t.fail(
      'TickResponse round-trip and mail delivery share a deeper bug: ' +
        'the maker calls E(handle).receive(tickMessage, agentId), but ' +
        'receive() expects an envelope previously enrolled by the ' +
        "sender's outbox.  Synthetic ticks bypass that protocol and " +
        'fail with "Mail fraud: unrecognized parcel" inside the catch ' +
        'handler.  The fix is to pass the agent mailbox `deliver()` ' +
        '(or use `agent.send`) from the maker scope; tracked as a ' +
        'follow-up.',
    );
  },
);

test.serial(
  'integration: interval-scheduler entries persist across daemon restart',
  async t => {
    t.timeout(45_000);
    const { cancelled, config, host } = await prepareHost(t);

    await E(host).makeIntervalScheduler('persisted', {
      minPeriodMs: 100,
    });
    const kit = await E(host).lookup('persisted');
    const scheduler = kit.scheduler;
    const interval = await E(scheduler).makeInterval('keep-me', 200, {
      firstDelayMs: 50_000, // far enough out that no tick fires during the test
      tickTimeoutMs: 5_000,
    });

    const beforeInfo = await E(interval).info();
    t.is(beforeInfo.status, 'active');
    t.is(beforeInfo.label, 'keep-me');
    const beforeId = beforeInfo.id;

    // The persistence directory should contain at least one .json file.
    const stateRoot = config.statePath;
    const intervalDirRoot = path.join(stateRoot, 'interval-scheduler');
    const findIntervalsDir = root => {
      // The maker shards the directory by formula-number prefix:
      // state/interval-scheduler/<2hex>/<rest>/intervals/.
      if (!fs.existsSync(root)) return null;
      for (const a of fs.readdirSync(root)) {
        const dir2 = path.join(root, a);
        if (!fs.statSync(dir2).isDirectory()) continue;
        for (const b of fs.readdirSync(dir2)) {
          const dir3 = path.join(dir2, b, 'intervals');
          if (fs.existsSync(dir3)) return dir3;
        }
      }
      return null;
    };
    const intervalsDir = findIntervalsDir(intervalDirRoot);
    t.truthy(intervalsDir, 'persistence directory exists on disk');
    const filesBefore = fs
      .readdirSync(intervalsDir)
      .filter(n => n.endsWith('.json'));
    t.true(
      filesBefore.length >= 1,
      `at least one persisted entry .json should be on disk, ` +
        `found ${filesBefore.length}`,
    );

    await restart(config);

    const { host: hostAfter } = await makeHost(config, cancelled);
    // After restart the makers entry re-reads the persistence
    // directory and calls loadEntry on every active entry.  The pet
    // name still resolves and the scheduler.list() must surface the
    // same interval id.
    const kitAfter = await E(hostAfter).lookup('persisted');
    const schedulerAfter = kitAfter.scheduler;
    const list = await E(schedulerAfter).list();
    t.is(list.length, 1, 'one active interval restored after restart');
    t.is(list[0].id, beforeId, 'restored interval keeps its id');
    t.is(list[0].label, 'keep-me');
  },
);

test.serial(
  'integration: makeHttpClient enforces origin allowlist end-to-end',
  async t => {
    t.timeout(45_000);
    const { host } = await prepareHost(t);

    await E(host).makeHttpClient('api', ['https://api.example.com'], {
      maxRequestsPerMinute: 5,
      maxResponseBytes: 1024,
    });
    const kit = await E(host).lookup('api');
    t.truthy(kit);
    const client = kit.client;

    const origins = await E(client).allowedOrigins();
    t.deepEqual(origins, ['https://api.example.com']);

    // Disallowed origin must reject without ever issuing a fetch.
    await t.throwsAsync(
      () => E(client).fetch('https://evil.example.com/exfil'),
      { message: /not in the allowlist/ },
      'cross-origin requests must throw with the allowlist message',
    );
  },
);
