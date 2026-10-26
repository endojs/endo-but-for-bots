// @ts-check
// prefer-endo-primitives-exempt: inference guards require callable remotables.

/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeTurnLedgerDriver } from '../turn-ledger.js';
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
