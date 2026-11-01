// @ts-check
// prefer-endo-primitives-exempt: inference guards require callable remotables.

/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeTurnLedgerDriver, stringsForInferResult } from '../turn-ledger.js';
import { Crash, makeFakeDaemon } from './_fake-host.js';

const message = harden({
  number: 41n,
  messageId: 'message-41',
  from: 'endo://fake/parent',
  to: 'endo://fake/child',
  strings: ['Summarize ', 'today.'],
});

const limits = harden({
  maxWallClockMs: 30_000,
  maxOutputBytes: 4096,
  maxTurns: 1,
});

const neverCancelled = new Promise(() => {});

const lifecycle = Far('Active lifecycle', {
  isActive: () => true,
});

const buildMcpServer = Far('buildMcpServer', () => harden({}));
const guest = harden({
  buildMcpServer,
  toolNames: harden(['notes.read']),
  formulaIdentifier: 'child:fake',
});

/**
 * @param {ReturnType<typeof makeFakeDaemon>} daemon
 * @param {any} agent
 * @param {any} inferenceBackend
 */
const makeDriver = (daemon, agent, inferenceBackend) =>
  makeTurnLedgerDriver({
    agent,
    ledger: daemon.host,
    lifecycle,
    inferenceBackend,
    guest,
    limits,
    cancelled: neverCancelled,
    instructions: 'Be concise.',
    model: 'fake-model',
  });

const isCrash = error =>
  /^(crash at|dead incarnation)/.test(/** @type {Error} */ (error).message);

test('turn ledger replays every crash cut with one recorded result', async t => {
  await null;
  let exercisedRecordedResultReplay = false;
  let exercisedRepublication = false;

  for (let cut = 1; ; cut += 1) {
    const daemon = makeFakeDaemon();
    const { agent, replies } = daemon.makeMailbox([message]);
    /** @type {any[]} */
    const requests = [];
    const inferenceBackend = Far('Fake inference backend', {
      async infer(request) {
        requests.push(request);
        return harden({ type: 'ok', text: 'Today is summarized.' });
      },
    });

    daemon.crashAfter(cut);
    let crashed = false;
    try {
      await makeDriver(daemon, agent, inferenceBackend).run();
    } catch (error) {
      if (!isCrash(error)) throw error;
      crashed = true;
    }

    if (crashed) {
      daemon.restart();
      const resultWasRecorded = await E(daemon.host).has('turn-41-result');
      const replyWasPublished = replies.length > 0;
      const publicationWasRecorded = await E(daemon.host).has(
        'turn-41-published',
      );
      await makeDriver(daemon, agent, inferenceBackend).run();
      if (resultWasRecorded) {
        exercisedRecordedResultReplay = true;
        t.is(requests.length, 1, `cut ${cut} did not infer again`);
      }
      if (replyWasPublished && !publicationWasRecorded) {
        exercisedRepublication = true;
        t.is(replies.length, 2, `cut ${cut} republished the recorded result`);
      }
    }

    t.true(await E(daemon.host).has('turn-41-started'));
    t.deepEqual(await E(daemon.host).lookup('turn-41-result'), {
      type: 'TurnResult',
      key: 41n,
      result: { type: 'ok', text: 'Today is summarized.' },
    });
    t.deepEqual(await E(daemon.host).lookup('turn-41-published'), {
      type: 'Published',
      key: 41n,
    });
    t.deepEqual(await E(daemon.host).lookup('turn-cursor'), {
      type: 'Cursor',
      key: 41n,
    });
    t.true(replies.length === 1 || replies.length === 2);
    for (const reply of replies) {
      t.deepEqual(reply, {
        strings: ['Today is summarized.'],
        replyTo: 'message-41',
        replyToMessageNumber: 41n,
      });
    }

    if (!crashed) {
      t.true(cut > 4, `the matrix exercised ${cut} crash cuts`);
      break;
    }
  }

  t.true(exercisedRecordedResultReplay);
  t.true(exercisedRepublication);
});

test('a crash inside infer repeats the asserted fake tool effect', async t => {
  const daemon = makeFakeDaemon();
  const { agent, replies } = daemon.makeMailbox([message]);
  let inferenceCalls = 0;
  let toolEffects = 0;
  let crashOnce = true;
  const inferenceBackend = Far('Crash-injecting inference backend', {
    async infer(request) {
      inferenceCalls += 1;
      t.is(request.guest, guest);
      toolEffects += 1;
      if (crashOnce) {
        crashOnce = false;
        throw new Crash('crash inside infer after fake tool effect');
      }
      return harden({ type: 'ok', text: 'Recovered answer.' });
    },
  });

  await t.throwsAsync(makeDriver(daemon, agent, inferenceBackend).run(), {
    message: 'crash inside infer after fake tool effect',
  });
  t.true(await E(daemon.host).has('turn-41-started'));
  t.false(await E(daemon.host).has('turn-41-result'));
  t.is(toolEffects, 1, 'the first externally visible tool effect happened');

  await makeDriver(daemon, agent, inferenceBackend).run();
  t.is(inferenceCalls, 2, 'TurnStarted without TurnResult re-ran infer');
  t.is(toolEffects, 2, 'the repeated tool effect is explicit, not hidden');
  t.deepEqual(replies, [
    {
      strings: ['Recovered answer.'],
      replyTo: 'message-41',
      replyToMessageNumber: 41n,
    },
  ]);
});

test('the backend sees only the child projection and inference request', async t => {
  const daemon = makeFakeDaemon();
  const { agent } = daemon.makeMailbox([message]);
  /** @type {any} */
  let observed;
  let acquired = 0;
  let released = 0;
  const credentialSource = Far('Credential source', {
    acquire() {
      acquired += 1;
      return harden({
        type: 'granted',
        env: harden({ API_TOKEN: 'held-inside-backend' }),
        release: Far('release credential', () => {
          released += 1;
        }),
      });
    },
  });
  const inferenceBackend = Far('Credential-owning fake backend', {
    async infer(request) {
      observed = request;
      const grant = await E(credentialSource).acquire();
      await E(grant.release)();
      return harden({ type: 'ok', text: 'Confined.' });
    },
  });

  await makeDriver(daemon, agent, inferenceBackend).run();
  t.deepEqual(Object.keys(observed).sort(), [
    'cancelled',
    'guest',
    'limits',
    'model',
    'prompt',
    'promptOrigin',
  ]);
  t.is(observed.guest, guest);
  t.deepEqual(observed.guest.toolNames, ['notes.read']);
  t.is(observed.prompt, 'Be concise.\n\nSummarize today.');
  t.is(observed.promptOrigin, 'guest-influenced');
  t.is(acquired, 1);
  t.is(released, 1);
  t.false(JSON.stringify(observed).includes('API_TOKEN'));
});

test('every inference result renders a total, provider-free reply', t => {
  t.deepEqual(stringsForInferResult(harden({ type: 'ok', text: 'Hi.' })), [
    'Hi.',
  ]);
  t.deepEqual(stringsForInferResult(harden({ type: 'needs-auth' })), [
    'Inference needs authentication.',
  ]);
  t.deepEqual(stringsForInferResult(harden({ type: 'usage-exhausted' })), [
    'Inference usage is exhausted.',
  ]);
  t.deepEqual(stringsForInferResult(harden({ type: 'rate-limited' })), [
    'Inference is rate limited.',
  ]);
  t.deepEqual(stringsForInferResult(harden({ type: 'budget-exhausted' })), [
    'Inference budget is exhausted.',
  ]);
  t.deepEqual(
    stringsForInferResult(
      harden({ type: 'limit-exceeded', which: 'output-bytes' }),
    ),
    ['Inference limit exceeded: output-bytes.'],
  );
  t.deepEqual(stringsForInferResult(harden({ type: 'cancelled' })), [
    'Inference was cancelled.',
  ]);
  t.deepEqual(stringsForInferResult(harden({ type: 'needs-containment' })), [
    'Inference needs containment.',
  ]);
  t.deepEqual(
    stringsForInferResult(harden({ type: 'unavailable', detail: 'offline' })),
    ['Inference unavailable: offline'],
  );
  t.throws(
    () => stringsForInferResult(/** @type {any} */ (harden({ type: 'odd' }))),
    { message: /Unknown inference result type "odd"/ },
  );
});

test('a non-ok result is recorded and published like any other', async t => {
  const daemon = makeFakeDaemon();
  const { agent, replies } = daemon.makeMailbox([message]);
  const inferenceBackend = Far('Rate-limited backend', {
    async infer() {
      return harden({ type: 'rate-limited' });
    },
  });
  await makeDriver(daemon, agent, inferenceBackend).run();
  t.deepEqual(await E(daemon.host).lookup('turn-41-result'), {
    type: 'TurnResult',
    key: 41n,
    result: { type: 'rate-limited' },
  });
  t.deepEqual(replies, [
    {
      strings: ['Inference is rate limited.'],
      replyTo: 'message-41',
      replyToMessageNumber: 41n,
    },
  ]);
});

test('process fails closed on malformed message numbers', async t => {
  const daemon = makeFakeDaemon();
  const { agent } = daemon.makeMailbox([message]);
  const inferenceBackend = Far('Unreached backend', {
    async infer() {
      throw Error('unreached');
    },
  });
  const driver = makeDriver(daemon, agent, inferenceBackend);
  await t.throwsAsync(
    driver.process(/** @type {any} */ ({ number: 41, from: 'x' })),
    { message: 'Message number must be a bigint' },
  );
  await t.throwsAsync(driver.process({ number: -1n, from: 'x' }), {
    message: /Turn key must be a natural message number/,
  });
  // A failed turn does not wedge the serial queue.
  await t.throwsAsync(driver.process({ number: 41n, from: 'x' }), {
    message: 'unreached',
  });
});

test('process fails closed on a forged result record or cursor', async t => {
  const inferenceBackend = Far('Unreached backend', {
    async infer() {
      throw Error('unreached');
    },
  });

  const forgedResult = makeFakeDaemon();
  await E(forgedResult.host).storeValue(
    harden({ type: 'TurnResult', key: 7n, result: { type: 'ok', text: '' } }),
    'turn-41-result',
  );
  const { agent: agentA, replies: repliesA } = forgedResult.makeMailbox([
    message,
  ]);
  await t.throwsAsync(
    makeDriver(forgedResult, agentA, inferenceBackend).process(message),
    { message: /Invalid result record for turn/ },
  );
  t.deepEqual(repliesA, []);

  const forgedCursor = makeFakeDaemon();
  await E(forgedCursor.host).storeValue(
    harden({ type: 'Published', key: 41n }),
    'turn-41-published',
  );
  await E(forgedCursor.host).storeValue(
    harden({ type: 'Bogus', key: 41n }),
    'turn-cursor',
  );
  const { agent: agentB } = forgedCursor.makeMailbox([message]);
  await t.throwsAsync(
    makeDriver(forgedCursor, agentB, inferenceBackend).process(message),
    { message: 'Invalid turn cursor' },
  );
});

test('the cursor only moves forward', async t => {
  const daemon = makeFakeDaemon();
  await E(daemon.host).storeValue(
    harden({ type: 'Cursor', key: 99n }),
    'turn-cursor',
  );
  const { agent } = daemon.makeMailbox([message]);
  const inferenceBackend = Far('Fake inference backend', {
    async infer() {
      return harden({ type: 'ok', text: 'Late.' });
    },
  });
  t.true(await makeDriver(daemon, agent, inferenceBackend).process(message));
  t.deepEqual(await E(daemon.host).lookup('turn-cursor'), {
    type: 'Cursor',
    key: 99n,
  });
});

test('defaults omit instructions, model, and absent strings', async t => {
  const daemon = makeFakeDaemon();
  const bare = harden({
    number: 3n,
    messageId: 'message-3',
    from: 'endo://fake/parent',
  });
  const { agent, replies } = daemon.makeMailbox([bare]);
  /** @type {any} */
  let observed;
  const inferenceBackend = Far('Observing backend', {
    async infer(request) {
      observed = request;
      return harden({ type: 'ok', text: 'Empty.' });
    },
  });
  await makeTurnLedgerDriver({
    agent,
    ledger: daemon.host,
    lifecycle,
    inferenceBackend: /** @type {any} */ (inferenceBackend),
    guest,
    limits,
    cancelled: neverCancelled,
  }).run();
  t.is(observed.prompt, '');
  t.false('model' in observed);
  t.is(replies.length, 1);
});

test('run skips its own messages and stops when the agent goes inactive', async t => {
  const own = harden({
    number: 1n,
    messageId: 'message-1',
    from: 'endo://fake/child',
    strings: ['echo'],
  });
  const second = harden({ ...message, number: 42n, messageId: 'message-42' });
  /** @type {any[]} */
  const requests = [];
  const inferenceBackend = Far('Fake inference backend', {
    async infer(request) {
      requests.push(request);
      return harden({ type: 'ok', text: 'Answered.' });
    },
  });

  // Inactive before the loop starts: nothing is read or answered.
  const idle = makeFakeDaemon();
  const idleMailbox = idle.makeMailbox([message]);
  await makeTurnLedgerDriver({
    agent: idleMailbox.agent,
    ledger: idle.host,
    lifecycle: Far('Inactive lifecycle', { isActive: () => false }),
    inferenceBackend: /** @type {any} */ (inferenceBackend),
    guest,
    limits,
    cancelled: neverCancelled,
  }).run();
  t.deepEqual(idleMailbox.replies, []);
  t.is(requests.length, 0);

  // Active for the first three checks, then retired before message 42.
  const daemon = makeFakeDaemon();
  const { agent, replies } = daemon.makeMailbox([own, message, second]);
  let checks = 0;
  await makeTurnLedgerDriver({
    agent,
    ledger: daemon.host,
    lifecycle: Far('Retiring lifecycle', {
      isActive: () => {
        checks += 1;
        return checks <= 3;
      },
    }),
    inferenceBackend: /** @type {any} */ (inferenceBackend),
    guest,
    limits,
    cancelled: neverCancelled,
  }).run();
  t.is(requests.length, 1, 'own message skipped; retired before 42');
  t.deepEqual(
    replies.map(reply => reply.replyToMessageNumber),
    [41n],
  );
  t.false(await E(daemon.host).has('turn-1-started'));
  t.false(await E(daemon.host).has('turn-42-started'));
});
