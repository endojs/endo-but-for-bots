// @ts-check

import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { gunzip } from 'zlib';

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';
import { readTarEntries, tarPathSegments } from '@endo/tar/reader.js';

/** @import { PackageSource, RunCommand } from './types.js' */

/** An inflated npm package larger than this is refused. */
const maximumInflatedTarballBytes = 256 * 1024 * 1024;

const inflate = promisify(gunzip);
const execFileAsync = promisify(execFile);

/** @type {RunCommand} */
const runProcess = async (command, commandArguments, options) =>
  execFileAsync(command, commandArguments, options);

/**
 * Drops the single leading directory npm archives carry. No symbolic link is
 * ever created here, so a later entry cannot write through an earlier one.
 *
 * @param {string} archivePath
 * @param {string} destination
 */
export const extractPackageTarball = async (archivePath, destination) => {
  const inflated = await inflate(await fs.readFile(archivePath), {
    maxOutputLength: maximumInflatedTarballBytes,
  });
  const source = (async function* yieldInflated() {
    yield new Uint8Array(inflated);
  })();
  for await (const entry of readTarEntries(source)) {
    entry.type !== 'symlink' ||
      Fail`Package archive entry ${q(entry.path)} is a symbolic link`;
    const segments = tarPathSegments(entry.path).slice(1);
    const location = path.join(destination, ...segments);
    if (entry.type === 'directory') {
      await fs.mkdir(location, { recursive: true });
      for await (const _ of entry.content) {
        // Draining keeps the reader block-aligned.
      }
    } else if (segments.length === 0) {
      throw Fail`Package archive entry ${q(entry.path)} has no leading directory`;
    } else {
      await fs.mkdir(path.dirname(location), { recursive: true });
      // eslint-disable-next-line no-bitwise
      const mode = 0o644 | (entry.mode & 0o111);
      const handle = await fs.open(location, 'w', mode);
      try {
        for await (const chunk of entry.content) {
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
    }
  }
};
harden(extractPackageTarball);

/**
 * Lifecycle scripts stay off: fetching a package must not execute it.
 *
 * @param {string} specifier
 * @param {string} temporaryDirectory
 * @param {RunCommand} runCommand
 * @returns {Promise<string>}
 */
const fetchNpmPackage = async (specifier, temporaryDirectory, runCommand) => {
  const { stdout } = await runCommand(
    'npm',
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temporaryDirectory,
      specifier,
    ],
    { cwd: temporaryDirectory },
  );
  const [packed] = JSON.parse(stdout);
  const packageRoot = path.join(temporaryDirectory, 'package');
  await extractPackageTarball(
    path.join(temporaryDirectory, path.basename(packed.filename)),
    packageRoot,
  );
  return packageRoot;
};

/**
 * Produces a local directory holding the package a source names.
 *
 * @param {PackageSource} source
 * @param {string} temporaryDirectory Empty, and owned by the caller.
 * @param {object} [options]
 * @param {RunCommand} [options.runCommand]
 * @returns {Promise<string>}
 */
export const fetchPackage = async (
  source,
  temporaryDirectory,
  { runCommand = runProcess } = {},
) => {
  if (source.kind === 'npm') {
    return fetchNpmPackage(
      /** @type {string} */ (source.specifier),
      temporaryDirectory,
      runCommand,
    );
  }
  if (source.kind === 'git') {
    const packageRoot = path.join(temporaryDirectory, 'package');
    const referenceArguments =
      source.reference === undefined ? [] : ['--branch', source.reference];
    await runCommand(
      'git',
      [
        'clone',
        '--quiet',
        '--depth',
        '1',
        ...referenceArguments,
        '--',
        /** @type {string} */ (source.url),
        packageRoot,
      ],
      {
        cwd: temporaryDirectory,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    return packageRoot;
  }
  return /** @type {string} */ (source.directory);
};
harden(fetchPackage);
