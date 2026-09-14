import '@endo/init';
// The only host authority this entry point takes directly: argument vector,
// process exit status, and nothing else. Everything the demo does to the
// world it does through `platform`, the same powers the daemon receives.
import process from 'node:process';
import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import {
  makeThixotropeDaemon,
  makeFsStore,
  makeIronhorseEngine,
  inspectIronhorseStore,
} from '../index.js';
import {
  counterSource,
  callerSource,
} from '../src/ironhorse/demo-counter-vats.js';
import {
  producerSource,
  listenerSource,
} from '../src/ironhorse/demo-promise-vats.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const platform = makeNodePowers();
const { environment, files, logging, paths } = platform;

const [
  demo = 'counter',
  command = 'help',
  stateArgument = `./tmp/ironhorse-${demo}`,
  value,
] = process.argv.slice(2);
demo === 'counter' ||
  demo === 'promise' ||
  Fail`Expected counter or promise demo, got ${q(demo)}`;
const commands =
  demo === 'counter'
    ? ['init', 'status', 'inspect', 'incr', 'check']
    : ['init', 'status', 'inspect', 'listen', 'resolve', 'check'];
if (command === 'help') {
  logging.log(
    `Usage: yarn demo:ironhorse:${demo} ${commands.join('|')} [state-directory] [value]`,
  );
  process.exit(0);
}
commands.includes(command) || Fail`Unknown ${demo} command: ${q(command)}`;
const statePath = paths.resolve(stateArgument);
if (command === 'inspect') {
  logging.log(
    JSON.stringify(
      await inspectIronhorseStore({ files, paths }, statePath),
      null,
      2,
    ),
  );
  process.exit(0);
}
const packagePath = paths.fileURLToPath(new URL('../', import.meta.url));
const engine = makeIronhorseEngine(
  {
    processes: platform.processes,
    files,
    paths,
    timers: platform.timers,
    hashes: platform.hashes,
  },
  {
    workerBinary:
      environment.get('THIXOTROPE_IRONHORSE_WORKER') ??
      paths.resolve(
        packagePath,
        '../../target/release/thixotrope-ironhorse-worker',
      ),
    bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
      paths.join(packagePath, 'dist-ironhorse', name),
    ),
    storePath: paths.join(statePath, 'heaps'),
  },
);
const start = () =>
  makeThixotropeDaemon(
    {
      timers: platform.timers,
      random: platform.random,
      logging,
    },
    {
      store: makeFsStore({ syncFiles: platform.syncFiles, paths }, statePath),
      engine,
      codec: syrupCodec,
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    },
  );
await files.makeDirectory(statePath);
const configPath = paths.join(statePath, 'demo.json');
let daemon = await start();
try {
  let config;
  if (command === 'init') {
    daemon.listWorkerIds().length === 0 || Fail`init requires an empty demo`;
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
    // The publication is a bearer secret, so the file is owner-only and
    // lands in one durable step.
    await files.writeTextAtomic(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 },
    );
    logging.log(
      'Created two Ironhorse guest vats connected through the OCapN comms hub.',
    );
  } else {
    config = JSON.parse(await files.readText(configPath));
  }
  config.demo === demo ||
    Fail`Use a separate, fresh state directory for each demo`;
  if (command === 'status') {
    logging.log(
      JSON.stringify({ demo, workers: daemon.inspectWorkers() }, null, 2),
    );
    process.exitCode = 0;
  } else {
    let guest = await daemon.lookup(config.publication);
    if (command === 'incr') logging.log(String(await E(guest).incr()));
    if (command === 'listen') logging.log(await E(guest).listen());
    if (command === 'resolve')
      logging.log(await E(guest).resolve(value ?? 'resumed'));
    if (command === 'check') {
      if (demo === 'counter') {
        const before = await E(guest).read();
        (await E(guest).incr()) === before + 1n ||
          Fail`counter did not advance`;
        await daemon.shutdown();
        daemon = await start();
        guest = await daemon.lookup(config.publication);
        (await E(guest).read()) === before + 1n ||
          Fail`counter did not survive restart`;
        logging.log('PASS: cross-vat counter call and state survived restart.');
      } else {
        await E(guest).listen();
        await daemon.shutdown();
        daemon = await start();
        guest = await daemon.lookup(config.publication);
        (await E(guest).read()).settled === false ||
          Fail`listener settled before its producer resolved`;
        await E(guest).resolve('across restart');
        for (let i = 0; i < 100; i += 1) {
          if ((await E(guest).read()).settled) break;
        }
        const settlement = await E(guest).read();
        (settlement.settled === true &&
          settlement.value === 'across restart') ||
          Fail`listener settled with ${q(settlement)}`;
        logging.log(
          'PASS: persisted cross-vat promise listener settled after restart.',
        );
      }
    }
    logging.log(
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
