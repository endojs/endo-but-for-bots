// @ts-nocheck
/** @import { AddressInfo } from 'net' */

// Integration test: `E(host).makeFromPackage` runs a caplet from a mount whose
// root holds a `package.json` and no `node_modules`.  The daemon resolves the
// dependencies through `@registry`, which reads a registry served by this test
// on loopback, and a Node worker imports the entry against the resolved CAS
// trees.  See designs/daemon-worker-import-from-mount.md § Phase 2.
//
// The socket path lives under a short os.tmpdir() directory to stay within
// the ~104-character unix-domain-socket limit regardless of the checkout path.

import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import crypto from 'crypto';
import url from 'url';
import fs from 'fs';
import fsp from 'fs/promises';
import { E } from '@endo/eventual-send';
import { makeArchive as makeCompartmentArchive } from '@endo/compartment-mapper';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { ZipReader } from '@endo/zip/reader.js';
import { makeCancelKit } from '@endo/cancel';
import { decodeBase64 } from '@endo/base64';
import { encodeHex } from '@endo/hex';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import {
  tarFileHeader,
  tarFilePadding,
  tarEndMarker,
} from '@endo/tar/writer.js';
import { start, stop, restart, purge, makeEndoClient } from '../index.js';

/**
 * A gzipped npm tarball: every file under the leading `package/` directory.
 *
 * @param {Record<string, string>} files
 */
const makeTarball = files => {
  /** @type {Uint8Array[]} */
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

/**
 * @param {string} name
 * @param {string} version
 * @param {Record<string, string>} dependencies
 * @param {string} source
 */
const makePublishedPackage = (name, version, dependencies, source) => ({
  name,
  version,
  tarball: makeTarball({
    'package.json': JSON.stringify({
      name,
      version,
      type: 'module',
      main: 'index.js',
      dependencies,
    }),
    'index.js': source,
  }),
});

// `entry` wants dep-a@^1 and dep-b@^1; dep-b wants dep-a@^2.
const published = [
  makePublishedPackage('dep-a', '1.0.0', {}, 'export const major = 1;'),
  makePublishedPackage('dep-a', '1.4.0', {}, 'export const major = 1.4;'),
  makePublishedPackage('dep-a', '2.1.0', {}, 'export const major = 2;'),
  makePublishedPackage(
    'dep-b',
    '1.0.0',
    { 'dep-a': '^2.0.0' },
    "export { major as dependencyMajor } from 'dep-a';",
  ),
];

/**
 * Serve packuments and tarballs for `published` on loopback.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
const startRegistry = async () => {
  /** @type {string} */
  let base = '';
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent(request.url ?? '');
    const tarballMatch = /^\/-\/(.+)-(\d+\.\d+\.\d+)\.tgz$/.exec(requestPath);
    if (tarballMatch) {
      const [, name, version] = tarballMatch;
      const entry = published.find(
        candidate => candidate.name === name && candidate.version === version,
      );
      if (entry) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(entry.tarball);
        return;
      }
    }
    const name = requestPath.slice(1);
    const versions = published.filter(candidate => candidate.name === name);
    if (versions.length === 0) {
      response.writeHead(404);
      response.end();
      return;
    }
    const packument = {
      name,
      versions: Object.fromEntries(
        versions.map(({ version, tarball }) => [
          version,
          {
            name,
            version,
            dist: {
              tarball: `${base}/-/${name}-${version}.tgz`,
              integrity: `sha512-${crypto
                .createHash('sha512')
                .update(tarball)
                .digest('base64')}`,
            },
          },
        ]),
      ),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(packument));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};

const contexts = [];

const contentPathOf = (statePath, hashBase64) =>
  path.join(statePath, 'store-sha256', encodeHex(decodeBase64(hashBase64)));

const waitForCondition = async (predicate, message) => {
  await null;
  const startTime = Date.now();
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    if (Date.now() - startTime > 5000) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test.afterEach.always(async () => {
  while (contexts.length > 0) {
    const { cancel, config, root, registry } = contexts.pop();
    // eslint-disable-next-line no-await-in-loop
    await stop(config).catch(() => {});
    cancel(new Error('test teardown'));
    // eslint-disable-next-line no-await-in-loop
    await registry.close();
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Start a daemon whose `@registry` reads the loopback registry, and write
 * the entry package to a directory beside it.
 */
const prepare = async () => {
  const { cancel, cancelled } = makeCancelKit();
  const registry = await startRegistry();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'endo-mfp-'));
  const config = {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath: path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    gcEnabled: true,
  };
  contexts.push({ cancel, config, root, registry });
  // The daemon process reads its registry from the environment it inherits.
  process.env.ENDO_REGISTRY_URL = registry.url;
  await purge(config);
  await start(config);

  const sourceDirectory = path.join(root, 'entry');
  await fsp.mkdir(sourceDirectory);
  await fsp.writeFile(
    path.join(sourceDirectory, 'package.json'),
    JSON.stringify({
      name: 'entry',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^1.0.0' },
    }),
  );
  await fsp.writeFile(
    path.join(sourceDirectory, 'index.js'),
    `
      import { major } from 'dep-a';
      import { dependencyMajor } from 'dep-b';
      const ProbeInterface = M.interface('Probe', {
        majors: M.call().returns(M.record()),
        getEnvVar: M.call(M.string()).returns(M.opt(M.string())),
        marker: M.call().returns(M.promise()),
      });
      export const make = (_powers, _context, { env }) =>
        makeExo('Probe', ProbeInterface, {
          majors: () => harden({ entry: major, dependency: dependencyMajor }),
          getEnvVar: name => env[name],
          marker: async () => (await import('./marker.js')).marker,
        });
    `,
  );
  await fsp.writeFile(
    path.join(sourceDirectory, 'marker.js'),
    "export const marker = 'original';\n",
  );

  const connect = async () => {
    const { getBootstrap, closed } = await makeEndoClient(
      'client',
      config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    return E(getBootstrap()).host();
  };
  const host = await connect();
  await E(host).provideMount(sourceDirectory, 'entry-mount', {
    readOnly: true,
  });
  return { host, config, connect, sourceDirectory };
};

test.serial(
  'makeFromPackage runs a package.json-rooted mount against @registry',
  async t => {
    const { host } = await prepare();
    const caplet = await E(host).makeFromPackage(undefined, 'entry-mount', {
      env: { HELLO: 'from-package' },
    });
    // dep-a@^1 selects the minimal 1.0.0 under MVS; dep-b links dep-a@2.
    t.deepEqual(await E(caplet).majors(), { entry: 1, dependency: 2 });
    t.is(await E(caplet).getEnvVar('HELLO'), 'from-package');
  },
);

test.serial(
  'makeFromPackage snapshots a live mount before a deferred import',
  async t => {
    const { host, sourceDirectory } = await prepare();
    const caplet = await E(host).makeFromPackage(undefined, 'entry-mount');
    await fsp.writeFile(
      path.join(sourceDirectory, 'marker.js'),
      "export const marker = 'changed';\n",
    );
    t.is(await E(caplet).marker(), 'original');
  },
);

test.serial(
  'makeFromPackage retains its snapshot only for the caplet lifetime',
  async t => {
    const { host, config } = await prepare();
    await E(host).makeFromPackage(undefined, 'entry-mount', {
      resultName: 'snapshot-caplet',
    });
    const capletId = await E(host).identify('snapshot-caplet');
    const mountId = await E(host).identify('entry-mount');
    const diagnostics = await E(host).diagnostics();
    const capletFormula = await E(diagnostics).getFormula(capletId);
    const snapshotId = capletFormula.properties.source.identifier;
    t.not(snapshotId, mountId);
    t.is((await E(diagnostics).getFormula(snapshotId)).type, 'readable-tree');

    await E(host).storeIdentifier('snapshot-alias', snapshotId);
    const snapshot = await E(host).lookup('snapshot-alias');
    const contentPath = contentPathOf(
      config.statePath,
      await E(snapshot).sha256(),
    );
    t.true(fs.existsSync(contentPath));
    await E(host).remove('snapshot-alias');
    t.true(
      fs.existsSync(contentPath),
      'caplet retains snapshot content after its temporary alias is removed',
    );

    await E(host).cancel('snapshot-caplet');
    await E(host).remove('snapshot-caplet');
    await waitForCondition(
      async () => !fs.existsSync(contentPath),
      'snapshot content collection after the caplet ends',
    );
    await t.throwsAsync(E(diagnostics).getFormula(snapshotId), {
      message: /unknown identifier/,
    });
  },
);

test.serial('makeFromPackage reincarnates after a restart', async t => {
  const { host, config, connect } = await prepare();
  await E(host).makeFromPackage(undefined, 'entry-mount', {
    resultName: 'package-caplet',
    env: { HELLO: 'persist' },
  });
  await restart(config);
  const restartedHost = await connect();
  const caplet = await E(restartedHost).lookup('package-caplet');
  t.deepEqual(await E(caplet).majors(), { entry: 1, dependency: 2 });
  t.is(await E(caplet).getEnvVar('HELLO'), 'persist');
});

test.serial(
  'makeFromPackage offline fails cleanly when the registry lacks a package',
  async t => {
    const { host } = await prepare();
    await t.throwsAsync(
      E(host).makeFromPackage(undefined, 'entry-mount', { offline: true }),
      { message: /offline/ },
    );
  },
);

test.serial(
  'makeFromPackage reports a source without a package.json',
  async t => {
    const { host, config } = await prepare();
    const emptyDirectory = path.join(config.statePath, '..', 'empty');
    await fsp.mkdir(emptyDirectory);
    await E(host).provideMount(emptyDirectory, 'empty-mount', {
      readOnly: true,
    });
    await t.throwsAsync(E(host).makeFromPackage(undefined, 'empty-mount'), {
      message: /no package\.json/,
    });
  },
);

/**
 * Write the source archive of `test/fixtures/archive-env-echo` out as a
 * directory, so its root holds a compartment-map.json, and mount it.
 *
 * @param {any} host
 * @param {{ statePath: string }} config
 * @param {string} mountName
 */
const mountCompartmentMapTree = async (host, config, mountName) => {
  const fixtureLocation = new URL('fixtures/archive-env-echo/', import.meta.url)
    .href;
  const archiveBytes = await makeCompartmentArchive(
    makeReadPowers({ fs, url, crypto, path }),
    fixtureLocation,
    { parserForLanguage: defaultParserForLanguage },
  );
  const treeDirectory = path.join(config.statePath, '..', mountName);
  for (const [archivePath, file] of new ZipReader(archiveBytes).files) {
    const filePath = path.join(treeDirectory, archivePath);
    // eslint-disable-next-line no-await-in-loop
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fsp.writeFile(filePath, file.content);
  }
  await E(host).provideMount(treeDirectory, mountName, { readOnly: true });
};

test.serial(
  'makeFromMount runs a package.json root through makeFromPackage',
  async t => {
    const { host } = await prepare();
    const caplet = await E(host).makeFromMount(undefined, 'entry-mount', {
      registryName: '@registry',
      env: { HELLO: 'from-mount' },
    });
    t.deepEqual(await E(caplet).majors(), { entry: 1, dependency: 2 });
    t.is(await E(caplet).getEnvVar('HELLO'), 'from-mount');
  },
);

test.serial(
  'makeFromMount runs a compartment-map.json root through makeFromTree',
  async t => {
    const { host, config } = await prepare();
    await mountCompartmentMapTree(host, config, 'tree-mount');
    const caplet = await E(host).makeFromMount(undefined, 'tree-mount', {
      env: { HELLO: 'from-tree' },
    });
    t.is(await E(caplet).getEnvVar('HELLO'), 'from-tree');
  },
);

test.serial(
  'makeFromMount refuses package options for a compartment-map.json root',
  async t => {
    const { host, config } = await prepare();
    await mountCompartmentMapTree(host, config, 'tree-mount');
    await t.throwsAsync(
      E(host).makeFromMount(undefined, 'tree-mount', { offline: true }),
      { message: /compartment-map\.json, which takes no entry/ },
    );
  },
);

test.serial(
  'makeFromMount refuses a root with neither a compartment map nor a package',
  async t => {
    const { host, config } = await prepare();
    const emptyDirectory = path.join(config.statePath, '..', 'empty');
    await fsp.mkdir(emptyDirectory);
    await E(host).provideMount(emptyDirectory, 'empty-mount', {
      readOnly: true,
    });
    await t.throwsAsync(E(host).makeFromMount(undefined, 'empty-mount'), {
      message: /neither a compartment-map\.json nor a package\.json/,
    });
  },
);

test.serial(
  'makeFromMount offline succeeds once the registry holds every package',
  async t => {
    const { host } = await prepare();
    await E(host).makeFromMount(undefined, 'entry-mount');
    const caplet = await E(host).makeFromMount(undefined, 'entry-mount', {
      offline: true,
    });
    t.deepEqual(await E(caplet).majors(), { entry: 1, dependency: 2 });
  },
);

test.serial('makeFromMount reports an unknown registry name', async t => {
  const { host } = await prepare();
  await t.throwsAsync(
    E(host).makeFromMount(undefined, 'entry-mount', {
      registryName: 'no-such-registry',
    }),
    { message: /Unknown pet name for registry/ },
  );
});

test.serial('makeFromMount reports an unknown source name', async t => {
  const { host } = await prepare();
  await t.throwsAsync(E(host).makeFromMount(undefined, 'no-such-mount'), {
    message: /Unknown pet name for source/,
  });
});
