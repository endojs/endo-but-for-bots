// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import { makeWorkflowEngine, makeWorkflowSyncClient } from '../src/index.js';
import {
  featureChange,
  featureChangeParticipants,
} from './fixtures/feature-change.js';

/** @param {number} [rounds] */
const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

const makeEngine = async () => {
  const fs = makeInMemoryFilesystem();
  const storeRoot = await E(await E(fs).root()).makeDirectory('store', {});
  let idCounter = 0;
  let tick = 0;
  const inbox = /** @type {Array<{ resolve: (v: unknown) => void }>} */ ([]);
  const deliver = harden({
    /** @param {unknown} _t @param {any} _p */
    request: (_t, _p) => new Promise(resolve => inbox.push({ resolve })),
    /** @param {unknown} _t @param {any} _p */
    form: (_t, _p) => new Promise(resolve => inbox.push({ resolve })),
    /** @param {unknown} _t @param {string} _m @param {unknown[]} _a @param {any} _o */
    call: (_t, _m, _a, _o) => new Promise(resolve => inbox.push({ resolve })),
    /** @param {unknown} t @param {string} m */
    attenuate: (t, m) => Promise.resolve(`${t}#${m}`),
  });
  const engine = await makeWorkflowEngine({
    storeRoot,
    deliver,
    now: () => {
      tick += 1;
      return tick;
    },
    makeId: () => {
      idCounter += 1;
      return String(idCounter);
    },
    warn: () => {},
  });
  return { engine, inbox };
};

test('stop() settles done() promptly on an idle run (no hang, no leak)', async t => {
  const { engine } = await makeEngine();
  await E(engine.service).define('feature-change', featureChange);
  const { observer } = await E(engine.service).start('feature-change', {
    input: { request: 'r', branch: 'b' },
    participants: featureChangeParticipants,
  });
  await flush();

  const client = makeWorkflowSyncClient(observer);
  await flush();
  // The run is now idle in `implementing`, parked awaiting the next
  // event that will never come without participant action.
  t.is(/** @type {any} */ (client.state).state, 'implementing');

  client.stop();
  // done() must settle — pre-fix it hung forever because the parked
  // reader was never woken.
  const settled = await Promise.race([
    client.done.then(() => 'settled'),
    flush(50).then(() => 'timeout'),
  ]);
  t.is(settled, 'settled');
});

test('stop() before the first history() resolves still terminates', async t => {
  const { engine } = await makeEngine();
  await E(engine.service).define('feature-change', featureChange);
  const { observer } = await E(engine.service).start('feature-change', {
    input: { request: 'r', branch: 'b' },
    participants: featureChangeParticipants,
  });
  const client = makeWorkflowSyncClient(observer);
  // Stop immediately, before the sync loop's first history() settles.
  client.stop();
  const settled = await Promise.race([
    client.done.then(() => 'settled'),
    flush(50).then(() => 'timeout'),
  ]);
  t.is(settled, 'settled');
});

test('a persistently failing observer gives up instead of spinning forever', async t => {
  let calls = 0;
  const brokenObserver = harden({
    history: () => {
      calls += 1;
      throw Error('connection lost');
    },
  });
  let errorCount = 0;
  const client = makeWorkflowSyncClient(brokenObserver, {
    onError: () => {
      errorCount += 1;
    },
  });
  await Promise.race([client.done, flush(80)]);
  // Bounded, not infinite: the retry budget caps the attempts.
  t.true(calls <= 10, `history() called ${calls} times`);
  t.true(errorCount <= 10);
});
