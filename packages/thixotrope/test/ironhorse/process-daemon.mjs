// @ts-check
import '@endo/init';
import { decodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../../src/daemon.js';
import { callerSource, counterSource } from '../../src/demo-counter-vats.js';
import { makeIronhorseEngine } from '../../src/ironhorse-engine.js';
import { makeFsStore } from '../../src/store-fs.js';

import { makeNodePowers } from '../../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

const [statePath] = process.argv.slice(2);
const packagePath = fileURLToPath(new URL('../../', import.meta.url));
const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  join(packagePath, '../../target/release/thixotrope-ironhorse-worker');
const rawStore = makeFsStore(nodePowers, statePath);
let ownerId;
let armed;
const increment = b64 => {
  const r = syrupCodec.makeReader(decodeBase64(b64));
  r.enterRecord();
  if (r.readSelectorAsString() !== 'op:deliver') return false;
  r.enterRecord();
  r.readSelectorAsString();
  r.readInteger();
  r.exitRecord();
  r.enterList();
  return r.readSelectorAsString() === 'incr';
};
const boundary = phase => {
  if (armed !== phase) return;
  armed = undefined;
  process.send?.({ event: 'boundary', phase });
  // Stop synchronously at the boundary, without draining another task. The
  // parent then sends SIGKILL; there is no shutdown/crash helper on this path.
  process.kill(process.pid, 'SIGSTOP');
};
const store = harden({
  ...rawStore,
  provideWorkerStore: id => {
    const s = rawStore.provideWorkerStore(id);
    return harden({
      ...s,
      appendJournal: entry => {
        s.appendJournal(entry);
        if (
          id === ownerId &&
          armed === 'journal' &&
          increment(typeof entry === 'string' ? entry : entry.b64)
        )
          boundary('journal');
      },
      setMeta: meta => {
        s.setMeta(meta);
        if (id === ownerId && meta.snapshot) boundary('snapshot');
      },
    });
  },
});
const rawEngine = makeIronhorseEngine(nodePowers, {
  workerBinary,
  bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
    join(
      process.env.THIXOTROPE_BOOT_DIR ?? join(packagePath, 'dist-ironhorse'),
      name,
    ),
  ),
  storePath: join(statePath, 'heaps'),
  crankBudget: Number(process.env.THIXOTROPE_CRANK_BUDGET ?? 10_000_000),
});
const engine = harden({
  ...rawEngine,
  start: async options => {
    let active = false;
    const worker = await rawEngine.start({
      ...options,
      onOutbound: frame => {
        if (active) boundary('heap');
        options.onOutbound(frame);
        if (active) boundary('output');
      },
    });
    return harden({
      ...worker,
      deliver: async message => {
        active =
          options.debugName.startsWith('owner(') &&
          message.t === 'f' &&
          increment(message.b64);
        try {
          await worker.deliver(message);
        } finally {
          active = false;
        }
      },
    });
  },
});
const start = () =>
  makeThixotropeDaemon(nodePowers, {
    store,
    engine,
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });
let daemon;
let publication;
try {
  let config;
  try {
    config = JSON.parse(
      await readFile(join(statePath, 'process.json'), 'utf8'),
    );
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw error;
  }
  ownerId = config?.ownerId;
  daemon = await start();
  if (!config) {
    const owner = await daemon.createWorker({ debugLabel: 'owner' });
    ownerId = owner.workerId;
    const guest = await daemon.createWorker({ debugLabel: 'guest' });
    const counter = await owner.evaluate(counterSource);
    const caller = await guest.evaluate(callerSource, { counter });
    config = { ownerId, publication: daemon.publish(caller) };
    await writeFile(join(statePath, 'process.json'), JSON.stringify(config));
    await daemon.shutdown();
    daemon = await start();
  }
  publication = config.publication;
  process.send?.({ event: 'ready' });
} catch (error) {
  process.send?.({
    event: 'error',
    message: /** @type {Error} */ (error).message,
  });
  process.exit(1);
}
process.on('message', async message => {
  const { command, phase } = /** @type {{command: string, phase?: string}} */ (
    message
  );
  try {
    if (command === 'kill-at') {
      const caller = await daemon.lookup(publication);
      if (phase === 'snapshot') {
        await E(caller).incr();
        armed = phase;
        await daemon.getWorker(ownerId).sleep();
      } else {
        armed = phase;
        await E(caller).incr();
      }
      throw Error(`boundary not reached: ${phase}`);
    }
    if (command === 'probe') {
      const worker = await daemon.createWorker();
      process.send?.({
        event: 'result',
        value: await worker.evaluate('6 * 7'),
      });
    }
    if (command === 'read') {
      const caller = await daemon.lookup(publication);
      process.send?.({
        event: 'result',
        count: String(await E(caller).read()),
      });
    }
    if (command === 'stop') {
      await daemon.shutdown();
      process.disconnect?.();
    }
  } catch (error) {
    process.send?.({
      event: 'error',
      message: /** @type {Error} */ (error).message,
    });
  }
});
