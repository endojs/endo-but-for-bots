// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { makeEndoClient, restart, start, stop } from '../index.js';

test.serial(
  'guarded guest/host mail preserves large tasks, replies and edits across restart',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp(
      path.join(
        process.platform === 'darwin' ? '/tmp' : tmpdir(),
        'endo-mail-',
      ),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: false,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      await null;
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'mail-workload-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    const host = await connect();
    const guest = await E(host).provideGuest('guest', {
      agentName: 'guest-agent',
    });
    const task = 't'.repeat(1024 ** 2);
    const answer = 'a'.repeat(1024 ** 2);
    const edited = 'e'.repeat(1024 ** 2);
    const prompt = 'p'.repeat(1024 ** 2);
    const formula = await E(host).makeUnconfined(
      '@node',
      new URL('./_mail-workload-env.js', import.meta.url).href,
      {
        powersName: '@agent',
        resultName: 'env-echo',
        env: { FAE_SUBAGENT_PROMPT: prompt },
      },
    );
    t.true((await E(formula).read()) === prompt);

    // Both the host and guest are real guarded daemon facets. A fake mailbox
    // would miss the implicit M.string() limit that used to reject these sizes.
    await E(host).send('guest', [task], [], []);
    const taskMessage = (await E(guest).listMessages()).find(
      message => message.strings?.[0] === task,
    );
    if (!taskMessage) throw Error('Guest did not receive the task');
    await E(guest).reply(taskMessage.number, [answer], [], []);
    const answerMessage = (await E(guest).listMessages()).find(
      message => message.strings?.[0] === answer,
    );
    if (!answerMessage) throw Error('Guest reply was not recorded');
    await E(guest).editMessage(answerMessage.number, [edited], [], []);
    t.true(
      (await E(host).listMessages()).some(
        message =>
          message.strings?.[0] === edited &&
          message.replyTo === taskMessage.messageId,
      ),
    );

    await E(guest).send('@host', [task], [], []);
    const guestTask = (await E(host).listMessages()).find(
      message =>
        message.strings?.[0] === task &&
        message.messageId !== taskMessage.messageId,
    );
    if (!guestTask) throw Error('Host did not receive the guest task');
    await E(host).reply(guestTask.number, [answer], [], []);
    const hostAnswer = (await E(host).listMessages()).find(
      message =>
        message.strings?.[0] === answer &&
        message.replyTo === guestTask.messageId,
    );
    if (!hostAnswer) throw Error('Host reply was not recorded');
    await E(host).editMessage(hostAnswer.number, [edited], [], []);
    const before = await E(host).listMessages();
    t.is(before.filter(message => message.strings?.[0] === edited).length, 2);
    const priorRevisions = await E(host).messageHistory(hostAnswer.number);
    t.is(priorRevisions.length, 2);
    t.true(priorRevisions[0].envelope.strings?.[0] === answer);
    t.true(priorRevisions[1].envelope.strings?.[0] === edited);

    await restart(config);
    const restoredHost = await connect();
    const after = await E(restoredHost).listMessages();
    t.is(after.length, before.length);
    for (const [index, message] of after.entries()) {
      t.is(message.messageId, before[index].messageId);
      t.is(message.replyTo, before[index].replyTo);
      t.true(message.strings?.[0] === before[index].strings?.[0]);
    }
    // Revision replay is a separate existing durability gap. This regression
    // checks the latest payloads and immutable formula construction data.
    const restoredFormula = await E(restoredHost).lookup('env-echo');
    t.true((await E(restoredFormula).read()) === prompt);
  },
);
