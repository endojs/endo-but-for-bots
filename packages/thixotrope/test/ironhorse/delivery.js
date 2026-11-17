// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

/** @import { WorkerIncarnation } from '../../src/core/worker-engine.js' */

const powers = makeNodePowers();
const packagePath = fileURLToPath(new URL('../../', import.meta.url));
const binary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  join(packagePath, '../../target/release/thixotrope-ironhorse-worker');
const boot = `
(() => {
  let outbound = [];
  globalThis.thixotropeSend = frame => outbound.push(JSON.parse(frame));
  globalThis.thixotropeTakeOutbound = () => {
    const result = outbound; outbound = []; return result;
  };
  const send = kind => thixotropeSend(JSON.stringify({ kind }));
  const registry = new FinalizationRegistry(() => {
    send('finalizer');
    Promise.resolve().then(() => send('cleanup-job'));
  });
  globalThis.thixotropeDispatch = text => {
    const message = JSON.parse(text);
    send(message.t);
    if (message.t === 'go') Promise.resolve().then(() => {
      send('job'); registry.register({}, 0);
    });
  };
})();
`;

for (const combined of [true, false]) {
  test.serial(
    `native delivery includes cleanup frames and restores (${combined ? 'combined' : 'legacy handshake'})`,
    async t => {
      t.timeout(30_000);
      const root = await mkdtemp('/tmp/thix-delivery-');
      /** @type {(() => Promise<void>) | undefined} */
      let release;
      /** @type {WorkerIncarnation | undefined} */
      let worker;
      t.teardown(async () => {
        try {
          await worker?.terminate();
          await release?.();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
      const bootPath = join(root, 'boot.js');
      await writeFile(bootPath, boot);
      /** @type {any[]} */
      const requests = [];
      const processes = harden({
        ...powers.processes,
        spawn: (executable, args, options) => {
          const child = powers.processes.spawn(executable, args, options);
          if (!args[0]?.endsWith('/heap.sqlite')) return child;
          return harden({
            ...child,
            input: fd => {
              const stream = child.input(fd);
              if (!stream || fd !== 0) return stream;
              return harden({
                write: text => {
                  requests.push(JSON.parse(text));
                  stream.write(text);
                },
                end: text => stream.end(text),
              });
            },
            lines: fd =>
              fd !== 1 || combined
                ? child.lines(fd)
                : {
                    async *[Symbol.asyncIterator]() {
                      for await (const line of child.lines(fd)) {
                        const reply = JSON.parse(line);
                        if (reply.op === 'ready') delete reply.features;
                        yield JSON.stringify(reply);
                      }
                    },
                  },
          });
        },
      });
      const engine = makeIronhorseEngine(
        { ...powers, processes },
        {
          workerBinary: binary,
          bootPaths: [bootPath],
          storePath: join(root, 'heaps'),
        },
      );
      if (!engine.acquireStore)
        throw Error('Ironhorse requires store ownership');
      release = await engine.acquireStore(root);
      const frames = [];
      worker = await engine.start({
        debugName: 'delivery',
        snapshot: null,
        onOutbound: frame => frames.push(frame),
      });
      requests.length = 0;
      await worker.deliver({ t: 'go' });
      t.deepEqual(
        frames.map(frame => frame.kind),
        ['go', 'job', 'finalizer', 'cleanup-job'],
      );
      t.deepEqual(
        requests.map(request => request.op),
        combined ? ['deliver'] : ['eval', 'eval'],
      );
      if (combined) t.is(requests[0].drainBudget, '10000000');
      await worker.snapshot();
      requests.length = 0;
      frames.length = 0;
      await worker.deliver({ t: 'after' });
      t.deepEqual(
        frames,
        [{ kind: 'after' }],
        'no duplicated finalizer frames after restore',
      );
      t.deepEqual(
        requests.map(request => request.op),
        combined ? ['deliver'] : ['eval', 'eval'],
      );
    },
  );
}
