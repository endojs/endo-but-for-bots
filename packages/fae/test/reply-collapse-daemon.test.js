// @ts-check
// prefer-endo-primitives-exempt: the guest projection requires a callable remotable.

import test from '@endo/ses-ava/prepare-endo.js';

import { makeEndoClient, start, stop } from '@endo/daemon';
import { E } from '@endo/eventual-send';
import { makeTurnLedgerDriver } from '@endo/exo-agent-factory/turn-ledger.js';
import { Far } from '@endo/far';
import { makeExecuteTool } from '@endo/lal/tool-dispatch.js';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeListMessagesTool } from '../src/tool-makers.js';

test.serial(
  'daemon republication keeps replyTo and each agent view shows it once',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp(path.join(tmpdir(), 'reply-collapse-'));
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

    await start(config);
    const client = await makeEndoClient(
      'reply-collapse-test',
      config.sockPath,
      cancelled.promise,
    );
    void client.closed.catch(() => {});
    const host = E(client.getBootstrap()).host();
    const child = await E(host).provideGuest('child', {
      agentName: 'child-agent',
    });

    await E(host).send('child', ['Question?'], [], []);
    const parentMessage = (await E(child).listMessages()).find(
      candidate => candidate.strings?.[0] === 'Question?',
    );
    if (parentMessage === undefined) throw Error('Child did not receive mail');

    const records = new Map();
    let crashAfterPublication = true;
    const ledger = Far('Crash-injecting turn ledger', {
      has: name => records.has(name),
      lookup: name => records.get(name),
      storeValue: (value, name) => {
        if (
          crashAfterPublication &&
          value?.type === 'Published' &&
          name === `turn-${parentMessage.number}-published`
        ) {
          crashAfterPublication = false;
          throw Error('crash after daemon reply publication');
        }
        records.set(name, value);
      },
    });
    let inferenceCalls = 0;
    const inferenceBackend = Far('Fake inference backend', {
      infer: () => {
        inferenceCalls += 1;
        return harden({ type: 'ok', text: 'Recorded answer.' });
      },
    });
    const lifecycle = Far('Active lifecycle', { isActive: () => true });
    const guestProjection = harden({
      buildMcpServer: Far('buildMcpServer', () => harden({})),
      formulaIdentifier: 'child:test',
      toolNames: harden([]),
    });
    const makeDriver = () =>
      makeTurnLedgerDriver({
        agent: child,
        ledger,
        lifecycle,
        inferenceBackend,
        guest: guestProjection,
        limits: harden({
          maxWallClockMs: 30_000,
          maxOutputBytes: 4096,
          maxTurns: 1,
        }),
        cancelled: new Promise(() => {}),
      });

    await t.throwsAsync(makeDriver().process(parentMessage), {
      message: 'crash after daemon reply publication',
    });
    t.true(await makeDriver().process(parentMessage));
    t.is(inferenceCalls, 1, 'republication reused the recorded result');

    const rawReplies = (await E(host).listMessages()).filter(
      candidate => candidate.strings?.[0] === 'Recorded answer.',
    );
    t.is(rawReplies.length, 2, 'the daemon retains both publications');
    t.not(rawReplies[0].messageId, rawReplies[1].messageId);
    for (const reply of rawReplies) {
      t.is(reply.replyTo, parentMessage.messageId);
    }

    const faeView = /** @type {any[]} */ (
      await makeListMessagesTool(host).execute({})
    );
    const lalView = /** @type {any[]} */ (
      await makeExecuteTool(host)('listMessages', {})
    );
    /** @param {any[]} messages */
    const visibleReplies = messages =>
      messages.filter(
        candidate => candidate.strings?.[0] === 'Recorded answer.',
      );
    t.is(visibleReplies(faeView).length, 1);
    t.is(visibleReplies(lalView).length, 1);
    t.is(visibleReplies(faeView)[0].replyTo, parentMessage.messageId);
    t.is(visibleReplies(lalView)[0].replyTo, parentMessage.messageId);
  },
);
