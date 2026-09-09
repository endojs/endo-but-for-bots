import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();
import '@endo/init';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, open, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import {
  makeThixotropeDaemon,
  makeFsStore,
  makeIronhorseEngine,
  inspectIronhorseStore,
} from '../index.js';
import { counterSource, callerSource } from '../src/demo-counter-vats.js';
import { producerSource, listenerSource } from '../src/demo-promise-vats.js';

const [
  demo = 'counter',
  command = 'help',
  stateArgument = `./tmp/ironhorse-${demo}`,
  value,
] = process.argv.slice(2);
assert.ok(
  demo === 'counter' || demo === 'promise',
  'Expected counter or promise demo',
);
const commands =
  demo === 'counter'
    ? ['init', 'status', 'inspect', 'incr', 'check']
    : ['init', 'status', 'inspect', 'listen', 'resolve', 'check'];
if (command === 'help') {
  console.log(
    `Usage: yarn demo:ironhorse:${demo} ${commands.join('|')} [state-directory] [value]`,
  );
  process.exit(0);
}
assert.ok(commands.includes(command), `Unknown ${demo} command: ${command}`);
const statePath = resolve(stateArgument);
if (command === 'inspect') {
  console.log(
    JSON.stringify(await inspectIronhorseStore(nodePowers, statePath), null, 2),
  );
  process.exit(0);
}
const packagePath = fileURLToPath(new URL('../', import.meta.url));
const engine = makeIronhorseEngine(nodePowers, {
  workerBinary:
    process.env.THIXOTROPE_IRONHORSE_WORKER ??
    resolve(packagePath, '../../target/release/thixotrope-ironhorse-worker'),
  bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
    join(packagePath, 'dist-ironhorse', name),
  ),
  storePath: join(statePath, 'heaps'),
});
const start = () =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine,
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });
await mkdir(statePath, { recursive: true });
const configPath = join(statePath, 'demo.json');
let daemon = await start();
try {
  let config;
  if (command === 'init') {
    assert.equal(
      daemon.listWorkerIds().length,
      0,
      'init requires an empty demo',
    );
    const firstVat = await daemon.createWorker({
      debugLabel: demo === 'counter' ? 'counter' : 'producer',
    });
    const secondVat = await daemon.createWorker({
      debugLabel: demo === 'counter' ? 'caller' : 'listener',
    });
    const first = await firstVat.evaluate(
      demo === 'counter' ? counterSource : producerSource,
    );
    const second = await secondVat.evaluate(
      demo === 'counter' ? callerSource : listenerSource,
      demo === 'counter' ? { counter: first } : { producer: first },
    );
    config = {
      demo,
      publication: daemon.publish(second),
      firstId: firstVat.workerId,
      secondId: secondVat.workerId,
    };
    const temporary = `${configPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    const file = await open(temporary, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, configPath);
    const directory = await open(statePath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    console.log(
      'Created two Ironhorse guest vats connected through the OCapN comms hub.',
    );
  } else {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  }
  assert.equal(
    config.demo,
    demo,
    'Use a separate, fresh state directory for each demo',
  );
  if (command === 'status') {
    console.log(
      JSON.stringify({ demo, workers: daemon.inspectWorkers() }, null, 2),
    );
    process.exitCode = 0;
  } else {
    let guest = await daemon.lookup(config.publication);
    if (command === 'incr') console.log(String(await E(guest).incr()));
    if (command === 'listen') console.log(await E(guest).listen());
    if (command === 'resolve')
      console.log(await E(guest).resolve(value ?? 'resumed'));
    if (command === 'check') {
      if (demo === 'counter') {
        const before = await E(guest).read();
        assert.equal(await E(guest).incr(), before + 1n);
        await daemon.shutdown();
        daemon = await start();
        guest = await daemon.lookup(config.publication);
        assert.equal(await E(guest).read(), before + 1n);
        console.log('PASS: cross-vat counter call and state survived restart.');
      } else {
        await E(guest).listen();
        await daemon.shutdown();
        daemon = await start();
        guest = await daemon.lookup(config.publication);
        assert.deepEqual(await E(guest).read(), { settled: false });
        await E(guest).resolve('across restart');
        for (let i = 0; i < 100; i += 1) {
          if ((await E(guest).read()).settled) break;
        }
        assert.deepEqual(await E(guest).read(), {
          settled: true,
          value: 'across restart',
        });
        console.log(
          'PASS: persisted cross-vat promise listener settled after restart.',
        );
      }
    }
    console.log(
      JSON.stringify(
        {
          vats: daemon.listWorkerIds(),
          ...(demo === 'counter'
            ? { count: String(await E(guest).read()) }
            : { promise: await E(guest).read() }),
        },
        null,
        2,
      ),
    );
  }
} finally {
  await daemon.shutdown();
}
