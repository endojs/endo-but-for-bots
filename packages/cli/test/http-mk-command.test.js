// @ts-nocheck
/* global process */

import os from 'os';
import path from 'path';
import http from 'node:http';
import test from 'ava';
import url from 'url';
import { execa, $ } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();
const endoBin = path.join(dirname, '..', 'bin', 'endo');

// Isolated daemon context so this test file does not collide with
// concurrent CLI tests (see formula-collection.test.js for the same
// pattern).
const testRoot = path.join(dirname, 'tmp', 'endo-http-mk');
const endoEnv = {
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  XDG_RUNTIME_DIR: path.join(testRoot, 'run'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  ENDO_SOCK: path.join(os.tmpdir(), `endo-http-mk-${process.pid}.sock`),
  ENDO_ADDR: '127.0.0.1:0',
};

for (const [key, value] of Object.entries(endoEnv)) {
  process.env[key] = value;
}

test('endo --help advertises the http subcommand', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  t.regex(stdout, /\bhttp\b/, 'help output should mention the http subcommand');
});

test('endo http --help advertises mk', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'http', '--help']);
  t.regex(stdout, /Usage: endo http/);
  t.regex(stdout, /\bmk\b/);
});

test('endo http mk --help describes the --origin flag', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'http',
    'mk',
    '--help',
  ]);
  t.regex(stdout, /--origin/);
  t.regex(stdout, /controller-name/);
  t.regex(stdout, /client-name/);
});

test.serial(
  'endo http mk registers controller and client pet names',
  async t => {
    // Spin up a tiny HTTP server for the allowlist origin.
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const addr = /** @type {import('net').AddressInfo} */ (server.address());
    const origin = `http://127.0.0.1:${addr.port}`;
    t.teardown(
      () =>
        new Promise(resolve => {
          server.close(() => resolve(undefined));
        }),
    );

    const cli = $({ cwd: dirname });
    await cli`endo purge -f`;
    await cli`endo start`;
    try {
      // Run mk and capture both pet names from stdout.
      const result =
        await cli`endo http mk my-control my-client --origin ${origin}`;
      const lines = result.stdout.split('\n').filter(Boolean);
      t.deepEqual(
        lines,
        ['my-control', 'my-client'],
        'mk should print the two pet names it registered',
      );

      // Verify both names are reachable via endo list.
      const list = await cli`endo list`;
      t.regex(list.stdout, /\bmy-control\b/);
      t.regex(list.stdout, /\bmy-client\b/);
    } finally {
      await cli`endo purge -f`;
    }
  },
);
