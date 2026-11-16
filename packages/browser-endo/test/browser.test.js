// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBrowserEndo } from '../src/index.js';
import { makeCounter } from '../src/counter.js';
import { startRelay } from './helpers.js';

// Build is an explicit prerequisite (also in the package test script), so this
// checks the actual hosted module's exports and native browser WebSocket API.
test.serial(
  'hosted counter works in two real browser pages and reconnects without replay',
  async t => {
    t.timeout(30_000);
    const options = await startRelay(t);
    const owner = makeBrowserEndo(options);
    t.teardown(owner.close);
    const locator = await owner.export(makeCounter());
    const server = createServer((req, res) => {
      const path = new URL(req.url || '/', 'http://local').pathname;
      const file = new URL(`../dist${path}`, import.meta.url);
      readFile(file).then(
        bytes => {
          res.setHeader(
            'Content-Type',
            path.endsWith('.js') ? 'text/javascript' : 'text/html',
          );
          res.end(bytes);
        },
        () => {
          res.statusCode = 404;
          res.end();
        },
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.teardown(
      () => new Promise(resolve => server.close(() => resolve(undefined))),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP');
    const fragment = new URLSearchParams({
      relay: options.relay,
      relayDomain: options.relayDomain,
      'cap.counter': locator,
    });
    const url = `http://127.0.0.1:${address.port}/counter-app/index.html#${fragment}`;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./browser-runner.mjs', import.meta.url)), url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.teardown(() => child.kill());
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    const [code] = await once(child, 'exit');
    t.is(code, 0, output);
  },
);
