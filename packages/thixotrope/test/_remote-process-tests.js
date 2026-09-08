// @ts-check
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../src/daemon.js';
import { makeDurableNetLayer } from '../src/durable-netlayer.js';
import { makeFsStore } from '../src/store-fs.js';
import { makeTestOcapn } from './_util.js';
import {
  isIncrement,
  makeProcessTestEngine,
} from './_remote-process-fixture.js';

/** @import {ExecutionContext, TestFn} from 'ava' */

/** @param {ExecutionContext} t @param {string} path @param {'replay' | 'ironhorse'} kind */
const launch = async (t, path, kind) => {
  const child = fork(
    fileURLToPath(new URL('./_remote-process-daemon.mjs', import.meta.url)),
    [path, kind],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const exited = once(child, 'exit');
  let diagnostic = '';
  child.stderr?.on('data', chunk => {
    diagnostic = `${diagnostic}${String(chunk)}`.slice(-16_384);
  });
  t.teardown(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  /** @type {any[]} */
  const messages = [];
  /** @type {((message: any) => void) | undefined} */
  let pending;
  child.on('message', message => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(message);
    } else messages.push(message);
  });
  const receive = () =>
    Promise.race([
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise(resolve => {
            pending = resolve;
          }),
      exited.then(() => {
        throw Error(`receiver exited before reply: ${diagnostic}`);
      }),
    ]);
  const ready = await receive();
  t.is(ready.event, 'ready');
  return { child, exited, receive, ready };
};

/** @param {TestFn} test @param {'replay' | 'ironhorse'} kind */
export const registerRemoteProcessTests = (test, kind) => {
  for (const phase of ['before-dispatch', 'after-dispatch']) {
    test.serial(
      `remote SIGKILL ${phase} after sender releases its copy (${kind})`,
      async t => {
        t.timeout(120_000);
        const path = await mkdtemp(join(tmpdir(), 'thix-wire-kill-'));
        t.teardown(() => rm(path, { recursive: true, force: true }));
        const receiverPath = join(path, 'receiver');
        const senderPath = join(path, 'sender');
        const first = await launch(t, receiverPath, kind);
        const senderStore = makeFsStore(senderPath);
        /** @type {{token: string, n: bigint} | undefined} */
        let sent;
        /** @type {() => void} */
        let resolveAccepted;
        const accepted = new Promise(resolve => {
          resolveAccepted = () => resolve(undefined);
        });
        let armed = false;
        const sender = await makeThixotropeDaemon({
          store: senderStore,
          engine: makeProcessTestEngine(kind, senderPath),
          codec: syrupCodec,
          makeNetlayer: ({ handlers, logger, resumption }) =>
            makeDurableNetLayer({
              handlers,
              logger,
              resumption: harden({
                ...resumption,
                recordOutbound: (token, n, bytes, sequence) => {
                  resumption.recordOutbound(token, n, bytes, sequence);
                  if (armed && isIncrement(bytes)) sent = { token, n };
                },
                recordAck: (token, /** @type {bigint} */ n) => {
                  resumption.recordAck(token, n);
                  if (sent?.token === token && n >= sent.n) resolveAccepted();
                },
              }),
              makeBaseNetlayer: powers =>
                makeTcpNetLayer({
                  ...powers,
                  specifiedDesignator: `${basename(path)}-sender`,
                }),
            }),
        });
        t.teardown(() => sender.shutdown());
        const worker = await sender.createWorker({ debugLabel: 'caller' });
        const caller = await worker.evaluate(`(() => {
        let counter;
        return Far('Caller', {
          hold: value => { counter = value; return true; },
          incr: () => E(counter).incr(),
          read: () => E(counter).read(),
        });
      })()`);
        const publication = sender.publish(caller);
        const client = await makeTestOcapn({
          codec: syrupCodec,
          network: (handlers, logger) =>
            makeDurableNetLayer({
              handlers,
              logger,
              makeBaseNetlayer: powers =>
                makeTcpNetLayer({
                  ...powers,
                  specifiedDesignator: `${basename(path)}-client`,
                }),
            }),
        });
        t.teardown(() => client.shutdown());
        const counter = await client.enlivenSturdyRef(
          client.makeSturdyRef(first.ready.location, first.ready.publication),
        );
        const remoteCaller = await client.enlivenSturdyRef(
          client.makeSturdyRef(sender.location, publication),
        );
        t.true(await E(remoteCaller).hold(counter));
        t.is(await E(counter).read(), 0n);
        t.is(await E(remoteCaller).read(), 0n);
        first.child.send({ command: 'arm', phase });
        t.is((await first.receive()).event, 'armed');
        armed = true;
        const result = E(remoteCaller).incr();
        // Attach both outcomes immediately so failed cleanup cannot create an
        // unhandled rejection that obscures the test's boundary assertion.
        const outcome = result.then(
          value => ({ value }),
          error => ({ error }),
        );
        const boundary = await first.receive();
        t.is(boundary.event, 'boundary');
        t.is(boundary.phase, phase);
        await accepted;
        if (!sent) throw Error('sender did not record the invocation');
        t.is(boundary.token, sent.token);
        t.is(boundary.n, String(sent.n));
        const senderMeta = senderStore
          .provideSessionStore(sent.token)
          .getMeta();
        t.true(BigInt(senderMeta.ackSeq) >= sent.n);
        t.false(
          senderMeta.frames.some(
            (/** @type {any} */ frame) => frame.n === boundary.n,
          ),
          'sender has durably discarded the invocation payload',
        );
        const receiverStore = makeFsStore(receiverPath);
        const receiverMeta = receiverStore
          .provideSessionStore(sent.token)
          .getMeta();
        t.true(
          receiverMeta.inbox.some(
            (/** @type {any} */ frame) => frame.n === boundary.n,
          ),
        );
        t.true(
          BigInt(receiverMeta.processedSeq) < sent.n,
          'inbox cleanup has not committed',
        );
        const hubSession =
          receiverStore.getHubState().sessions[`peer:${sent.token}`];
        t.truthy(hubSession);
        t.is(
          BigInt(hubSession.processedUpTo) >= sent.n,
          phase === 'after-dispatch',
          'the receiver stopped at the selected hub commit boundary',
        );
        first.child.kill('SIGKILL');
        t.is((await first.exited)[1], 'SIGKILL');
        const second = await launch(t, receiverPath, kind);
        t.deepEqual(second.ready.location, first.ready.location);
        t.deepEqual(await outcome, { value: 1n });
        t.is(
          await E(remoteCaller).read(),
          1n,
          'no lost or duplicate invocation',
        );
        t.is(
          await E(remoteCaller).incr(),
          2n,
          'the same durable reference continues to work',
        );
      },
    );
  }
};
harden(registerRemoteProcessTests);
