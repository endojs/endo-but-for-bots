// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as popen from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as url from 'node:url';
import { E } from '@endo/eventual-send';

import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicControlPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';

/** @param {import('ava').ExecutionContext} t */
const prepare = t => {
  const cancelled = makePromiseKit();
  const forced = makePromiseKit();
  const forked = makePromiseKit();
  const signals = [];
  const closedLogs = [];
  const writes = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
    kill: (signal = 'SIGTERM') => {
      signals.push(signal);
      return true;
    },
  });
  const controls = {
    makePath: async () => {},
    write: async () => {},
    fork: () => child,
  };
  const powers = makeDaemonicControlPowers(
    /** @type {any} */ ({ statePath: '/state', ephemeralStatePath: '/tmp' }),
    () => '/worker.js',
    /** @type {any} */ ({
      joinPath: (...parts) => parts.join('/'),
      makePath: () => controls.makePath(),
      writeFileText: async filePath => {
        writes.push(filePath);
        await controls.write();
      },
      removePath: async () => {},
    }),
    /** @type {any} */ ({
      openSync: () => 42,
      closeSync: fd => closedLogs.push(fd),
    }),
    /** @type {any} */ ({
      fork: () => {
        const result = controls.fork();
        forked.resolve(undefined);
        return result;
      },
    }),
  );
  t.teardown(() => {
    cancelled.reject(Error('Test finished'));
    forced.reject(Error('Test finished'));
    child.stdio[3]?.destroy();
    child.stdio[4]?.destroy();
    child.emit('close', 0);
  });
  const make = () =>
    powers.makeWorker(
      'worker-id',
      /** @type {any} */ (Far('Daemon', {})),
      /** @type {Promise<never>} */ (cancelled.promise),
      /** @type {Promise<never>} */ (forced.promise),
    );
  return {
    make,
    child,
    controls,
    cancelled,
    forced,
    forked,
    signals,
    closedLogs,
    writes,
  };
};

test('native worker waits for child close after cancellation and process exit', async t => {
  t.timeout(5000);
  const { make, child, cancelled, signals, closedLogs } = prepare(t);
  const { workerTerminated, workerDaemonFacet } = await make();
  void Promise.resolve(workerDaemonFacet).catch(() => {});
  let complete = false;
  void workerTerminated.then(() => {
    complete = true;
  });
  cancelled.reject(Error('Stop'));
  await nextTurn();
  t.deepEqual(signals, ['SIGTERM']);
  t.deepEqual(closedLogs, [42]);
  t.false(complete, 'closing CapTP is not child release');
  child.emit('exit', 0);
  await nextTurn();
  t.false(complete, 'exit is not yet stdio closure');
  child.emit('close', 0);
  await workerTerminated;
  t.true(complete);
});

test('native worker signals cancellation while post-fork setup is pending', async t => {
  t.timeout(5000);
  const fixture = prepare(t);
  const held = makePromiseKit();
  fixture.controls.write = () => held.promise;
  const creating = fixture.make();
  await fixture.forked.promise;
  fixture.cancelled.reject(Error('Stop while starting'));
  await nextTurn();
  t.deepEqual(fixture.signals, ['SIGTERM']);
  fixture.forced.reject(Error('Force while starting'));
  await nextTurn();
  t.deepEqual(fixture.signals, ['SIGTERM', 'SIGKILL']);
  held.resolve(undefined);
  const { workerTerminated, workerDaemonFacet } = await creating;
  void Promise.resolve(workerDaemonFacet).catch(() => {});
  let complete = false;
  void workerTerminated.then(() => {
    complete = true;
  });
  await nextTurn();
  t.false(complete);
  fixture.child.emit('close', 0);
  await workerTerminated;
});

test('native worker setup rejection retains the child until stdio closes', async t => {
  t.timeout(5000);
  const fixture = prepare(t);
  fixture.controls.write = async () => {
    throw Error('Cannot write pid');
  };
  const creating = fixture.make();
  const rejected = t.throwsAsync(creating, { message: 'Cannot write pid' });
  let complete = false;
  void rejected.then(() => {
    complete = true;
  });
  await fixture.forked.promise;
  await nextTurn();
  t.deepEqual(fixture.signals, ['SIGKILL']);
  t.false(complete);
  fixture.child.emit('exit', 1);
  await nextTurn();
  t.false(complete);
  fixture.child.emit('close', 1);
  await rejected;
});

test('native worker cancellation before paths finish prevents fork', async t => {
  t.timeout(5000);
  const fixture = prepare(t);
  const held = makePromiseKit();
  fixture.controls.makePath = () => held.promise;
  const creating = fixture.make();
  const rejected = t.throwsAsync(creating, {
    message: /cancelled before native acquisition/,
  });
  fixture.cancelled.reject(Error('Stop'));
  await nextTurn();
  held.resolve(undefined);
  await rejected;
  t.deepEqual(fixture.closedLogs, []);
  t.deepEqual(fixture.signals, []);
});

test('native worker fork failure releases the parent log descriptor', async t => {
  const fixture = prepare(t);
  fixture.controls.fork = () => {
    throw Error('Cannot fork');
  };
  await t.throwsAsync(fixture.make(), { message: 'Cannot fork' });
  t.deepEqual(fixture.closedLogs, [42]);
});

test('native worker spawn error is observed and waits for close', async t => {
  t.timeout(5000);
  const fixture = prepare(t);
  const held = makePromiseKit();
  fixture.controls.write = () => held.promise;
  const creating = fixture.make();
  const rejected = t.throwsAsync(creating, { message: 'Spawn failed' });
  await fixture.forked.promise;
  fixture.child.emit('error', Error('Spawn failed'));
  held.resolve(undefined);
  await nextTurn();
  t.deepEqual(fixture.signals, ['SIGKILL']);
  fixture.child.emit('close', -1);
  await rejected;
});

test.serial(
  'worker context cancellation owns pending acquisition and late closure',
  async t => {
    t.timeout(10_000);
    const temporary = await mkdtemp(
      path.join(tmpdir(), 'endo-worker-lifecycle-'),
    );
    t.teardown(() => rm(temporary, { recursive: true, force: true }));
    const cancelled = makePromiseKit();
    const filePowers = makeFilePowers({ fs, path });
    const powers = await makeDaemonicPowers({
      config: {
        statePath: path.join(temporary, 'state'),
        ephemeralStatePath: path.join(temporary, 'ephemeral'),
        cachePath: path.join(temporary, 'cache'),
        sockPath: path.join(temporary, 'socket'),
      },
      cancelled: /** @type {Promise<never>} */ (cancelled.promise),
      fs,
      popen,
      url,
      filePowers,
      cryptoPowers: makeCryptoPowers(crypto),
      registryPowers: {
        fetch: async () => {
          throw Error('Unexpected network access');
        },
        gunzip,
        createHash: crypto.createHash,
      },
    });
    t.teardown(() => {
      cancelled.reject(Error('Test finished'));
    });
    await powers.persistence.initializePersistence();
    const acquiring = makePromiseKit();
    const acquired = makePromiseKit();
    const terminated = makePromiseKit();
    const signalled = makePromiseKit();
    const forceSignalled = makePromiseKit();
    const failedStarted = makePromiseKit();
    const failedAcquisition = makePromiseKit();
    const failedSignalled = makePromiseKit();
    t.teardown(() => {
      acquired.resolve(undefined);
      terminated.resolve(undefined);
      failedAcquisition.resolve(undefined);
    });
    let failNext = false;
    let deferNext = false;
    let terminateCalls = 0;
    const control = {
      makeWorker: async (_id, _facet, workerCancelled, forceCancelled) => {
        if (failNext) {
          void workerCancelled.catch(() => failedSignalled.resolve(undefined));
          failedStarted.resolve(undefined);
          await failedAcquisition.promise;
          throw Error('Worker acquisition failed');
        }
        void forceCancelled.catch(() => {});
        if (!deferNext) {
          return {
            workerDaemonFacet: Far('Worker', { terminate: () => {} }),
            workerTerminated: workerCancelled.catch(() => {}),
          };
        }
        void workerCancelled.catch(() => signalled.resolve(undefined));
        void forceCancelled.catch(() => forceSignalled.resolve(undefined));
        acquiring.resolve(undefined);
        await acquired.promise;
        return {
          workerDaemonFacet: Far('LateWorker', {
            terminate: () => {
              terminateCalls += 1;
            },
          }),
          workerTerminated: terminated.promise,
        };
      },
    };
    const daemon = await makeDaemon(
      { ...powers, control: /** @type {any} */ (control) },
      'worker-lifecycle-test',
      cancelled.reject,
      /** @type {Promise<never>} */ (cancelled.promise),
    );
    t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
    const host = await E(daemon.endoBootstrap).host();
    deferNext = true;
    const creating = E(host).provideWorker('late-worker');
    await acquiring.promise;
    let complete = false;
    const stopping = E(host).cancel(
      'late-worker',
      Error('Stop pending worker'),
    );
    void stopping.then(() => {
      complete = true;
    });
    await signalled.promise;
    t.false(complete);
    await forceSignalled.promise;
    t.is(terminateCalls, 0, 'force signal arrives before acquiring the facet');
    t.false(complete, 'force signal does not establish native closure');
    acquired.resolve(undefined);
    await creating;
    await nextTurn();
    t.is(terminateCalls, 1);
    t.false(complete, 'late worker acquisition is not termination');
    terminated.resolve(undefined);
    await stopping;
    t.true(complete);
    failNext = true;
    const failedCreate = t.throwsAsync(E(host).provideWorker('failed-worker'), {
      message: 'Worker acquisition failed',
    });
    await failedStarted.promise;
    const failedStop = t.throwsAsync(E(host).cancel('failed-worker'), {
      message: /Cancellation hooks failed/,
    });
    await failedSignalled.promise;
    failedAcquisition.resolve(undefined);
    await failedCreate;
    await failedStop;
    // AVA also checks that automatic cancellation's adopting rejection was
    // observed without consuming the explicit cancellation failure above.
    await nextTurn();
  },
);

test.serial(
  'native termination waits for a real child after its CapTP pipes close',
  async t => {
    t.timeout(10_000);
    const temporary = await mkdtemp(path.join(tmpdir(), 'endo-worker-close-'));
    t.teardown(() => rm(temporary, { recursive: true, force: true }));
    const cancelled = makePromiseKit();
    const forced = makePromiseKit();
    const ready = makePromiseKit();
    const pipeClosed = makePromiseKit();
    const childClosed = makePromiseKit();
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child;
    const powers = makeDaemonicControlPowers(
      {
        statePath: path.join(temporary, 'state'),
        ephemeralStatePath: path.join(temporary, 'ephemeral'),
        cachePath: path.join(temporary, 'cache'),
        sockPath: path.join(temporary, 'socket'),
      },
      url.fileURLToPath,
      makeFilePowers({ fs, path }),
      fs,
      /** @type {typeof popen} */ ({
        ...popen,
        fork: (_specifier, _args, options) => {
          child = popen.fork(
            new URL('./_worker-closed-transport.js', import.meta.url),
            [],
            options,
          );
          child.once('close', () => childClosed.resolve(undefined));
          child.once('message', message => {
            t.is(message, 'ready');
            ready.resolve(undefined);
          });
          child.stdio[4]?.once('close', () => pipeClosed.resolve(undefined));
          return child;
        },
      }),
    );
    t.teardown(async () => {
      cancelled.reject(Error('Test finished'));
      forced.reject(Error('Test finished'));
      if (child) {
        child.kill('SIGKILL');
        await childClosed.promise;
      }
    });
    const result = await powers.makeWorker(
      'real-worker',
      /** @type {any} */ (Far('Daemon', {})),
      /** @type {Promise<never>} */ (cancelled.promise),
      /** @type {Promise<never>} */ (forced.promise),
    );
    void Promise.resolve(result.workerDaemonFacet).catch(() => {});
    let complete = false;
    void result.workerTerminated.then(() => {
      complete = true;
    });
    await ready.promise;
    await pipeClosed.promise;
    t.false(
      complete,
      'closing native CapTP pipes does not release the process',
    );
    const pid = child?.pid;
    if (pid === undefined) throw Error('Worker has no pid');
    t.notThrows(() => process.kill(pid, 0));
    cancelled.reject(Error('Graceful stop'));
    await nextTurn();
    t.false(complete);
    forced.reject(Error('Force stop'));
    await result.workerTerminated;
    t.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);
