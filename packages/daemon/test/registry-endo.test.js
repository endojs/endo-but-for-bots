// @ts-nocheck
/* eslint-disable no-underscore-dangle */

// Integration test: the `@registry` special name is populated on every host
// (mirroring `@node`), so `E(host).lookup('@registry')` returns the host's
// package-registry directory tree without the caller branching on its
// presence. See designs/npm-registry-as-directory-tree.md.
//
// The socket path lives under a short os.tmpdir() directory to stay within
// the ~104-char unix-domain-socket limit regardless of the checkout path.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import http from 'http';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import {
  tarEndMarker,
  tarFileHeader,
  tarFilePadding,
} from '@endo/tar/writer.js';
import { start, stop, purge, makeEndoClient } from '../index.js';

const contexts = [];
const fixturePackageJson = JSON.stringify({
  name: 'fixture',
  version: '1.0.0',
});
const textEncoder = new TextEncoder();

const makeFixtureTarball = () => {
  const body = textEncoder.encode(fixturePackageJson);
  const chunks = [
    tarFileHeader('package/package.json', body.byteLength),
    body,
    tarFilePadding(body.byteLength),
    tarEndMarker(),
  ];
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(archive);
};

test.afterEach.always(async () => {
  while (contexts.length > 0) {
    const { cancel, config, root } = contexts.pop();
    // eslint-disable-next-line no-await-in-loop
    await stop(config).catch(() => {});
    cancel(new Error('test teardown'));
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

const prepare = async (t, registryUrl = undefined) => {
  const { cancel, cancelled } = makeCancelKit();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'endo-reg-'));
  const config = {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath: path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
    registryUrl,
  };
  await purge(config);
  await start(config);
  contexts.push({ cancel, config, root });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  return { host, cancelled };
};

const makeMetadataRegistry = async t => {
  const tarball = makeFixtureTarball();
  const integrity = `sha512-${createHash('sha512')
    .update(tarball)
    .digest('base64')}`;
  let registryUrl;
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture/-/fixture-1.0.0.tgz') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        versions: {
          '2.0.0': {
            dist: {
              integrity,
              tarball: `${registryUrl}/fixture/-/fixture-1.0.0.tgz`,
            },
          },
          '1.0.0': {
            dist: {
              integrity,
              tarball: `${registryUrl}/fixture/-/fixture-1.0.0.tgz`,
            },
          },
        },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.teardown(
    () =>
      new Promise(resolve => {
        server.close(resolve);
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test registry did not bind a TCP port');
  }
  registryUrl = `http://127.0.0.1:${address.port}`;
  return registryUrl;
};

test.serial(
  'E(host).lookup("@registry") resolves a registry root tree',
  async t => {
    const { host } = await prepare(t);
    const registry = await E(host).lookup('@registry');
    t.truthy(registry, '@registry is populated on the host');
    const help = await E(registry).help();
    t.true(typeof help === 'string' && help.includes('package registries'));
    t.deepEqual(await E(registry).list(), ['npm']);
  },
);

test.serial(
  '@registry exposes a non-enumerable npm package-name hub',
  async t => {
    const { host } = await prepare(t);
    const registry = await E(host).lookup('@registry');
    const npm = await E(registry).lookup('npm');
    const methods = await E(npm).__getMethodNames__();
    t.true(methods.includes('lookup'));
    t.true(methods.includes('has'));
    t.false(methods.includes('list'));
  },
);

test.serial(
  '@registry survives a fresh client connection (formula is persisted)',
  async t => {
    const { host, cancelled } = await prepare(t);
    const first = await E(host).lookup('@registry');
    t.truthy(first);
    // A second client over the same daemon still sees the slot; the host
    // formula carries the required registry field.
    const { getBootstrap, closed } = await makeEndoClient(
      'client-2',
      contexts[contexts.length - 1].config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const host2 = E(getBootstrap()).host();
    const again = await E(host2).lookup('@registry');
    t.truthy(again, '@registry resolves for a second client');
  },
);

test.serial(
  '@registry lists metadata through the configured backend without fetching a tarball',
  async t => {
    const registryUrl = await makeMetadataRegistry(t);
    const { host } = await prepare(t, registryUrl);
    const registry = await E(host).lookup('@registry');
    const npm = await E(registry).lookup('npm');
    const fixture = await E(npm).lookup('fixture');
    t.deepEqual(await E(fixture).list(), ['1.0.0', '2.0.0']);
  },
);

test.serial(
  '@registry provides an integrity-checked immutable package tree',
  async t => {
    const registryUrl = await makeMetadataRegistry(t);
    const { host } = await prepare(t, registryUrl);
    const registry = await E(host).lookup('@registry');
    const npm = await E(registry).lookup('npm');
    const fixture = await E(npm).lookup('fixture');
    const leaf = await E(fixture).lookup('1.0.0');
    const packageJson = await E(leaf).lookup('package.json');
    t.is(await E(packageJson).text(), fixturePackageJson);
    t.like(await E(leaf).getInfo(), {
      temporal: 'immutable',
    });
  },
);
