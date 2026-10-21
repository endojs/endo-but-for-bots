// @ts-nocheck
// prefer-endo-primitives-exempt: @endo/bytes is not in this tree; the
// TextEncoder here is the host-backed codec the mapper machine installs.
/* global globalThis, maybeReadFile, realPath, endorRunWriteFile */

/**
 * XS-hosted compartment mapper for `endor run <entry.js>` (Phase 4 of
 * `designs/endor-run-expanded.md`).
 *
 * Bundled by `scripts/bundle-endor-run-mapper-xs.mjs` into
 * `rust/endo/xsnap/src/endor_run_mapper.js` and evaluated in a
 * short-lived XS machine by `xsnap::map_entry_point`. The bundle installs
 * `globalThis.endorRunMapEntryPoint(path)`, which maps the application
 * rooted at the entry module with `@endo/compartment-mapper`, captures
 * every module it reaches, and hands each archive file to the
 * `endorRunWriteFile(path, bytes)` host function. That host function is
 * the mapper's only write power: it stores the bytes in the CAS under the
 * archive-relative path, so the files form the same tree an
 * `endor run <archive.zip>` of the equivalent archive would ingest.
 *
 * Host functions expected (from Rust):
 * - maybeReadFile, realPath (powers/fs, powers/process; `root` token)
 * - endorRunWriteFile (the mapper's CAS sink)
 */

import './endor-run-mapper-xs-shims.js';
import { mapNodeModules } from '@endo/compartment-mapper/node-modules.js';
import { captureFromMap } from '@endo/compartment-mapper/capture-lite.js';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';

const textEncoder = new TextEncoder();

/** @param {string} path */
const pathToFileURL = path =>
  `file://${path.split('/').map(encodeURIComponent).join('/')}`;

/** @param {string} location */
const fileURLToPath = location => {
  const { protocol, pathname } = new URL(location);
  if (protocol !== 'file:') {
    throw TypeError(`Not a file URL: ${location}`);
  }
  return decodeURIComponent(pathname);
};

/**
 * @param {string} path
 * @returns {Uint8Array | undefined}
 */
const maybeReadPath = path => {
  const result = maybeReadFile('root', path);
  if (result === undefined) {
    return undefined;
  }
  if (typeof result === 'string') {
    throw Error(`Cannot read ${path}: ${result}`);
  }
  return new Uint8Array(result);
};

/** @param {string} directory */
const hasPackageDescriptorAbove = directory => {
  let current = directory;
  for (;;) {
    if (maybeReadPath(`${current}/package.json`) !== undefined) {
      return true;
    }
    const parent = current.slice(0, current.lastIndexOf('/'));
    if (parent === current || current === '') {
      return false;
    }
    current = parent;
  }
};

/**
 * Read powers over the host file system.
 *
 * An entry module with no `package.json` anywhere above it is treated as
 * the sole module of an anonymous ESM package: the powers answer for a
 * synthetic `package.json` beside the entry, so `mapNodeModules` still has
 * a package root to map from.
 *
 * @param {string} entryPath
 */
const makeReadPowers = entryPath => {
  const entryDirectory = entryPath.slice(0, entryPath.lastIndexOf('/'));
  const syntheticDescriptorPath = hasPackageDescriptorAbove(entryDirectory)
    ? undefined
    : `${entryDirectory}/package.json`;
  const syntheticDescriptor = textEncoder.encode(
    JSON.stringify({
      name: 'endor-run-entry',
      version: '0.0.0',
      type: 'module',
    }),
  );

  /** @param {string} location */
  const maybeRead = async location => {
    const path = fileURLToPath(location);
    if (path === syntheticDescriptorPath) {
      return syntheticDescriptor;
    }
    return maybeReadPath(path);
  };

  /** @param {string} location */
  const read = async location => {
    const bytes = await maybeRead(location);
    if (bytes === undefined) {
      throw Error(`Cannot find file ${location}`);
    }
    return bytes;
  };

  /** @param {string} location */
  const canonical = async location => {
    const path = fileURLToPath(location);
    const resolved = realPath('root', path);
    if (resolved.startsWith('Error: ')) {
      return location;
    }
    const resolvedLocation = pathToFileURL(resolved);
    return location.endsWith('/') ? `${resolvedLocation}/` : resolvedLocation;
  };

  return Object.freeze({
    read,
    maybeRead,
    canonical,
    fileURLToPath,
    pathToFileURL,
    isAbsolute: path => path.startsWith('/'),
  });
};

/** @param {string} entryPath absolute path to the entry module */
const endorRunMapEntryPoint = async entryPath => {
  const readPowers = makeReadPowers(entryPath);
  const entryLocation = pathToFileURL(entryPath);

  const compartmentMap = await mapNodeModules(readPowers, entryLocation, {
    conditions: new Set(['xs']),
  });
  const { captureCompartmentMap, captureSources } = await captureFromMap(
    readPowers,
    compartmentMap,
    {
      parserForLanguage: defaultParserForLanguage,
      Compartment: globalThis.Compartment,
    },
  );

  // Same serialization and file layout as the archive writer in
  // `@endo/compartment-mapper/archive-lite.js`.
  const compartmentMapText = JSON.stringify(
    captureCompartmentMap,
    (key, value) => (key.startsWith('_') ? undefined : value),
    2,
  );
  endorRunWriteFile(
    'compartment-map.json',
    textEncoder.encode(compartmentMapText),
  );
  for (const compartmentName of Object.keys(captureSources).sort()) {
    const modules = captureSources[compartmentName];
    for (const specifier of Object.keys(modules).sort()) {
      const source = modules[specifier];
      if ('location' in source && source.bytes !== undefined) {
        endorRunWriteFile(
          `${compartmentName}/${source.location}`,
          source.bytes,
        );
      }
    }
  }
};

globalThis.endorRunMapEntryPoint = endorRunMapEntryPoint;
