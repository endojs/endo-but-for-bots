// @ts-check
import '@endo/init';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { makeNodePowers } from '../src/platform/node-powers.js';

import { makeThixotropeDaemon } from '../src/daemon.js';
import { makeDurableNetLayer } from '../src/durable-netlayer.js';
import { makeFsStore } from '../src/store-fs.js';
import { counterSource } from '../src/demo-counter-vats.js';
import {
  isIncrement,
  makeProcessTestEngine,
} from './_remote-process-fixture.js';

const nodePowers = makeNodePowers();

const [statePath, kindArg] = process.argv.slice(2);
const kind = /** @type {'replay' | 'ironhorse'} */ (kindArg);
const configPath = join(statePath, 'remote-process.json');
/** @type {string | undefined} */
let armed;
/** @type {ReturnType<typeof makeDurableNetLayer> extends Promise<infer T> ? T : never} */
let layer;
const pause = (/** @type {any} */ connection, /** @type {bigint} */ n) => {
  process.send?.({
    event: 'boundary',
    phase: armed,
    token: layer.getResumeToken(connection),
    n: String(n),
  });
  // No event loop or promise job can run between the selected dispatch
  // boundary and SIGKILL from the parent. The kernel can still deliver the
  // acknowledgement already written to TCP before this handler was entered.
  process.kill(process.pid, 'SIGSTOP');
};
let config;
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
    throw error;
}
const start = () =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makeProcessTestEngine(kind, statePath),
    codec: syrupCodec,
    makeNetlayer: async ({ handlers, logger, resumption }) => {
      layer = await makeDurableNetLayer(nodePowers, {
        handlers: harden({
          ...handlers,
          handleMessageData: (connection, bytes, n) => {
            const selected = armed !== undefined && isIncrement(bytes);
            if (selected && armed === 'before-dispatch') pause(connection, n);
            handlers.handleMessageData(connection, bytes, n);
            if (selected && armed === 'after-dispatch') pause(connection, n);
          },
        }),
        logger,
        resumption,
        makeBaseNetlayer: powers =>
          makeTcpNetLayer({
            ...powers,
            specifiedPort: config?.port ?? 0,
            specifiedDesignator: basename(statePath),
          }),
      });
      return layer;
    },
  });
let daemon = await start();
if (!config) {
  const worker = await daemon.createWorker({ debugLabel: 'counter' });
  const counter = await worker.evaluate(counterSource);
  config = {
    publication: daemon.publish(counter),
    port: Number(daemon.location.hints.port),
  };
  await writeFile(configPath, JSON.stringify(config));
  await daemon.shutdown();
  daemon = await start();
}
process.send?.({
  event: 'ready',
  location: daemon.location,
  publication: config.publication,
});
process.on('message', message => {
  const command = /** @type {{command: string, phase: string}} */ (message);
  if (command.command === 'arm') {
    armed = command.phase;
    process.send?.({ event: 'armed' });
  }
});
