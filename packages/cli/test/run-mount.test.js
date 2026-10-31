// @ts-nocheck
// spell-out-exempt: XDG_RUNTIME_DIR and ENDO_ADDR are environment variables
// the daemon reads under those names.
/** @import { AddressInfo } from 'net' */

// `endo run --mount` and `endo make --mount` run a caplet from a mounted
// tree through the daemon's `makeFromMount`.  The daemon-backed tests start
// a private daemon whose `@registry` reads a registry this test serves on
// loopback.  See designs/daemon-worker-import-from-mount.md § Phase 3.

import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import url from 'url';
import http from 'http';
import zlib from 'zlib';
import crypto from 'crypto';
import fs from 'fs/promises';
import { execa } from 'execa';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import {
  tarFileHeader,
  tarFilePadding,
  tarEndMarker,
} from '@endo/tar/writer.js';
import { checkMountFlags } from '../src/mount-caplet.js';
import { netListenAllowed } from './_net-permission.js';

const testDaemon = netListenAllowed ? test.serial : test.serial.skip;
const endoBin = url.fileURLToPath(new URL('../bin/endo.cjs', import.meta.url));

test('endo run --help advertises --mount, --registry, and --offline', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'run', '--help']);
  t.regex(stdout, /-m,--mount <name>/);
  t.regex(stdout, /--registry <name>/);
  t.regex(stdout, /--offline/);
});

test('endo make --help advertises --mount, --registry, and --offline', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'make', '--help']);
  t.regex(stdout, /-m,--mount <name>/);
  t.regex(stdout, /--registry <name>/);
  t.regex(stdout, /--offline/);
});

test('endo run --mount refuses arguments beyond its entry', async t => {
  const { exitCode, stderr } = await execa(
    process.execPath,
    [endoBin, 'run', '--mount', 'app', 'main.js', 'extra'],
    { reject: false },
  );
  t.not(exitCode, 0);
  t.regex(stderr, /takes no arguments beyond its entry/);
});

test('checkMountFlags accepts each source on its own', t => {
  t.is(checkMountFlags({ mountName: 'app' }), undefined);
  t.is(
    checkMountFlags({ mountName: 'app', registryName: 'npm', offline: true }),
    undefined,
  );
  t.is(checkMountFlags({ archiveName: 'archive' }), undefined);
  t.is(checkMountFlags({ importPath: 'plugin.js' }), undefined);
});

test('checkMountFlags requires --mount for --registry and --offline', t => {
  t.regex(checkMountFlags({ registryName: 'npm' }), /require --mount/);
  t.regex(checkMountFlags({ offline: true }), /require --mount/);
});

test('checkMountFlags refuses --mount beside another source', t => {
  t.regex(
    checkMountFlags({ mountName: 'app', archiveName: 'archive' }),
    /only one of --mount/,
  );
  t.regex(
    checkMountFlags({ mountName: 'app', importPath: 'plugin.js' }),
    /only one of --mount/,
  );
});

/**
 * A gzipped npm tarball: every file under the leading `package/` directory.
 *
 * @param {Record<string, string>} files
 */
const makeTarball = files => {
  const parts = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = encodeUtf8(text);
    parts.push(tarFileHeader(`package/${name}`, bytes.length));
    parts.push(bytes);
    parts.push(tarFilePadding(bytes.length));
  }
  parts.push(tarEndMarker());
  return zlib.gzipSync(Buffer.concat(parts));
};

const greetingTarball = makeTarball({
  'package.json': JSON.stringify({
    name: 'greeting',
    version: '1.2.0',
    type: 'module',
    main: 'index.js',
  }),
  'index.js': "export const greeting = 'hello';",
});

/**
 * Serve the `greeting@1.2.0` packument and tarball on loopback.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
const startRegistry = async () => {
  /** @type {string} */
  let base = '';
  const server = http.createServer((request, response) => {
    if (request.url === '/-/greeting-1.2.0.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(greetingTarball);
      return;
    }
    if (request.url !== '/greeting') {
      response.writeHead(404);
      response.end();
      return;
    }
    const integrity = crypto
      .createHash('sha512')
      .update(greetingTarball)
      .digest('base64');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name: 'greeting',
        versions: {
          '1.2.0': {
            name: 'greeting',
            version: '1.2.0',
            dist: {
              tarball: `${base}/-/greeting-1.2.0.tgz`,
              integrity: `sha512-${integrity}`,
            },
          },
        },
      }),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};

/**
 * @param {string} directory
 * @param {Record<string, string>} dependencies
 */
const writeProject = async (directory, dependencies) => {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: path.basename(directory),
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      dependencies,
    }),
  );
  await fs.writeFile(
    path.join(directory, 'index.js'),
    `
      import { greeting } from 'greeting';
      export const make = (_powers, _context, { env }) =>
        \`\${greeting} \${env.NAME ?? 'nobody'}\`;
    `,
  );
  await fs.writeFile(
    path.join(directory, 'farewell.js'),
    `export const make = () => 'goodbye';`,
  );
};

/** @type {{ root: string, endo: (...commandArguments: string[]) => Promise<any>, close: () => Promise<void> } | undefined} */
let daemon;

const startDaemon = async () => {
  const registry = await startRegistry();
  // A short root keeps the daemon's unix socket path within ~104 bytes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'endo-run-mount-'));
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    ENDO_SOCK: path.join(root, 'endo.sock'),
    ENDO_ADDR: '127.0.0.1:0',
    // The daemon reads `@registry`'s location from the environment it
    // inherits from `endo start`.
    ENDO_REGISTRY_URL: registry.url,
  };
  const endo = (...commandArguments) =>
    execa(process.execPath, [endoBin, ...commandArguments], {
      env,
      reject: false,
    });
  await endo('purge', '-f');
  const started = await endo('start');
  if (started.exitCode !== 0) {
    throw Error(`endo start failed: ${started.stderr}`);
  }
  await writeProject(path.join(root, 'app'), { greeting: '^1.0.0' });
  await writeProject(path.join(root, 'lonely'), { absent: '^1.0.0' });
  for (const name of ['app', 'lonely']) {
    // eslint-disable-next-line no-await-in-loop
    const mounted = await endo(
      'mount',
      path.join(root, name),
      '-n',
      name,
      '--read-only',
    );
    if (mounted.exitCode !== 0) {
      throw Error(`endo mount failed: ${mounted.stderr}`);
    }
  }
  daemon = {
    root,
    endo,
    close: async () => {
      await endo('purge', '-f');
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  return daemon;
};

test.after.always(async () => {
  await daemon?.close();
});

const provideDaemon = async () => daemon ?? startDaemon();

testDaemon(
  'endo run --mount --offline fails before the registry holds a dependency',
  async t => {
    const { endo } = await provideDaemon();
    const { exitCode, stderr } = await endo(
      'run',
      '--mount',
      'app',
      '--offline',
    );
    t.not(exitCode, 0);
    t.regex(stderr, /offline and no cached versions for "greeting"/);
  },
);

testDaemon('endo run --mount runs a package.json mount', async t => {
  const { endo } = await provideDaemon();
  const { exitCode, stdout, stderr } = await endo(
    'run',
    '--mount',
    'app',
    '-E',
    'NAME=world',
  );
  t.is(exitCode, 0, stderr);
  t.is(stdout.trim(), 'hello world');
});

testDaemon(
  'endo run --mount --offline succeeds once the registry holds every dependency',
  async t => {
    const { endo } = await provideDaemon();
    const { exitCode, stdout, stderr } = await endo(
      'run',
      '--mount',
      'app',
      '--offline',
    );
    t.is(exitCode, 0, stderr);
    t.is(stdout.trim(), 'hello nobody');
  },
);

testDaemon('endo run --mount takes an explicit entry module', async t => {
  const { endo } = await provideDaemon();
  const { exitCode, stdout, stderr } = await endo(
    'run',
    '--mount',
    'app',
    'farewell.js',
  );
  t.is(exitCode, 0, stderr);
  t.is(stdout.trim(), 'goodbye');
});

testDaemon(
  'endo make --mount --registry names a caplet from a package.json mount',
  async t => {
    const { endo } = await provideDaemon();
    const made = await endo(
      'make',
      '--mount',
      'app',
      '--registry',
      '@registry',
      '-n',
      'greeter',
      '-E',
      'NAME=maker',
    );
    t.is(made.exitCode, 0, made.stderr);
    t.is(made.stdout.trim(), 'hello maker');
    const shown = await endo('show', 'greeter');
    t.is(shown.stdout.trim(), 'hello maker');
  },
);

testDaemon(
  'endo run --mount --offline fails cleanly for a dependency the registry lacks',
  async t => {
    const { endo } = await provideDaemon();
    const { exitCode, stderr } = await endo(
      'run',
      '--mount',
      'lonely',
      '--offline',
    );
    t.not(exitCode, 0);
    t.regex(stderr, /offline and no cached versions for "absent"/);
  },
);

testDaemon('endo run --mount reports an unknown registry', async t => {
  const { endo } = await provideDaemon();
  const { exitCode, stderr } = await endo(
    'run',
    '--mount',
    'app',
    '--registry',
    'no-such-registry',
  );
  t.not(exitCode, 0);
  t.regex(stderr, /Unknown pet name for registry: \["no-such-registry"\]/);
});

testDaemon('endo run refuses --offline without --mount', async t => {
  const { endo } = await provideDaemon();
  const { exitCode, stderr } = await endo('run', '--offline', 'runlet.js');
  t.not(exitCode, 0);
  t.regex(stderr, /--registry and --offline require --mount <name>/);
});
