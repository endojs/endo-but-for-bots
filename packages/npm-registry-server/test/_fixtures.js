// @ts-check

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import {
  tarEndMarker,
  tarFileHeader,
  tarFilePadding,
} from '@endo/tar/writer.js';
import { makeFileCas } from '../src/cas.js';
import { makeRegistryStore } from '../src/store.js';
import { makeGrants } from '../src/grants.js';
import { makeRegistry } from '../src/registry.js';
import { devDateTagForVersion } from '../src/dev-release.js';

/**
 * Build an npm-shaped `.tgz` from `{ relativePath: text }` entries rooted
 * at `package/` (or a raw path when it starts with `!`).
 *
 * @param {Record<string, string>} files
 * @returns {Uint8Array}
 */
export const makeTgz = files => {
  /** @type {Uint8Array[]} */
  const parts = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const archivePath = name.startsWith('!')
      ? name.slice(1)
      : `package/${name}`;
    parts.push(tarFileHeader(archivePath, bytes.byteLength), bytes);
    parts.push(tarFilePadding(bytes.byteLength));
  }
  parts.push(tarEndMarker());
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
};

/** @returns {string} */
export const makeTempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'npm-registry-server-'));

/**
 * @param {Partial<Parameters<typeof makeRegistry>[0]>} [options]
 */
export const makeTestRegistry = (options = {}) => {
  const directory = makeTempDir();
  const store = makeRegistryStore(
    new Database(path.join(directory, 'db.sqlite')),
  );
  const cas = makeFileCas(path.join(directory, 'cas'));
  const grants = makeGrants({ store });
  const token = 'x'.repeat(40);
  grants.putGrant({
    id: 'test-grant',
    subject: 'garden-llm-publisher',
    packages: ['@endo/*', 'solo'],
    expiresAt: Date.now() + 3_600_000,
    token,
  });
  const registry = makeRegistry({
    store,
    cas,
    grants,
    publicOrigin: 'https://npm.example',
    ...options,
  });
  return {
    directory,
    store,
    cas,
    grants,
    registry,
    token,
    grant: grants.authenticate(token),
  };
};

/**
 * An npm publish document, as `npm publish` sends it.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.version
 * @param {string} [options.tag]
 * @param {Record<string, string>} [options.dependencies]
 * @param {Record<string, string>} [options.extraFiles]
 */
export const makePublishDocument = ({
  name,
  version,
  tag,
  dependencies,
  extraFiles = {},
}) => {
  const packageJson = {
    name,
    version,
    ...(dependencies ? { dependencies } : {}),
  };
  const tgz = makeTgz({
    'package.json': JSON.stringify(packageJson),
    'index.js': 'export default 1;\n',
    ...extraFiles,
  });
  const file = `${name.split('/').pop()}-${version}.tgz`;
  return {
    _id: name,
    name,
    'dist-tags': { [tag ?? devDateTagForVersion(version)]: version },
    versions: { [version]: { ...packageJson, _id: `${name}@${version}` } },
    _attachments: {
      [file]: {
        content_type: 'application/octet-stream',
        data: Buffer.from(tgz).toString('base64'),
        length: tgz.byteLength,
      },
    },
  };
};
