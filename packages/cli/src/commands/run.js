import fs from 'fs';
import url from 'url';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeArchive as makeCompartmentArchive } from '@endo/compartment-mapper';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import { defaultParserForLanguage as sourceParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { checkMountFlags, makeCapletFromMount } from '../mount-caplet.js';

const endowments = harden({
  // See https://github.com/Agoric/agoric-sdk/issues/9515
  assert: globalThis.assert,
  E,
  Far,
  makeExo,
  M,
  TextEncoder,
  TextDecoder,
  URL,
  console,
});

/**
 * @param {Uint8Array} archiveBytes
 * @param {unknown} powersP
 * @param {unknown[]} args
 */
const runArchiveBytes = async (archiveBytes, powersP, args) => {
  const [{ parseArchive }, { defaultParserForLanguage }] = await Promise.all([
    import('@endo/compartment-mapper'),
    import('@endo/compartment-mapper/import-archive-all-parsers.js'),
  ]);
  const application = await parseArchive(archiveBytes, '<archive>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import({ globals: endowments });
  const result = await /** @type {{main: Function}} */ (namespace).main(
    powersP,
    ...args,
  );
  if (result !== undefined) {
    console.log(result);
  }
};

export const run = async ({
  filePath,
  programArguments,
  archiveName,
  mountName,
  registryName,
  offline,
  importPath,
  powersName,
  agentNames,
  env = {},
}) => {
  await null;
  const mountFlagError = checkMountFlags({
    mountName,
    registryName,
    offline,
    archiveName,
    importPath,
  });
  if (mountFlagError !== undefined) {
    console.error(mountFlagError);
    process.exitCode = 1;
    return;
  }
  if (mountName !== undefined) {
    if (programArguments.length !== 0) {
      console.error(
        'A caplet run with --mount takes no arguments beyond its entry',
      );
      process.exitCode = 1;
      return;
    }
    // The caplet runs in a daemon worker rather than in this process, so
    // its env goes to the caplet instead of this process.
    await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
      await null;
      const result = await makeCapletFromMount(agent, {
        mountName,
        entry: filePath,
        registryName,
        offline,
        workerName: undefined,
        powersName,
        resultName: undefined,
        env,
      });
      if (result !== undefined) {
        console.log(result);
      }
    });
    return;
  }
  if (
    filePath === undefined &&
    importPath === undefined &&
    archiveName === undefined
  ) {
    console.error(
      'Specify at least one of --file, --archive, --mount, or --UNCONFINED',
    );
    process.exitCode = 1;
    return;
  }

  await withEndoAgent(
    agentNames,
    { os, process },
    async ({ bootstrap, agent }) => {
      await null;

      // Inject environment variables into process.env for ephemeral runs
      for (const [key, value] of Object.entries(env)) {
        process.env[key] = value;
      }

      let powersP;
      if (powersName === '@none') {
        powersP = E(bootstrap).leastAuthority();
      } else if (
        powersName === '@host' ||
        powersName === '@agent' ||
        powersName === 'AGENT'
      ) {
        powersP = agent;
      } else if (powersName === '@endo') {
        powersP = bootstrap;
      } else {
        // A slash-delimited powers name references a guest nested in a
        // directory; the parent directory must already exist (as with
        // `mkdir`, `store`, and `mv`).
        powersP = E(agent).provideGuest(parsePetNamePath(powersName));
      }

      if (importPath !== undefined) {
        if (archiveName !== undefined) {
          console.error(
            'Must specify either --archive or --UNCONFINED, not both',
          );
          process.exitCode = 1;
          return;
        }
        if (filePath !== undefined) {
          programArguments.unshift(filePath);
        }

        const importUrl = url.pathToFileURL(importPath).href;
        const namespace = await import(importUrl);
        const result = await namespace.main(powersP, ...programArguments);
        if (result !== undefined) {
          console.log(result);
        }
      } else if (archiveName !== undefined) {
        if (filePath !== undefined) {
          programArguments.unshift(filePath);
        }
        // Stream the archive bytes from the daemon.
        const archiveNamePath = parsePetNamePath(archiveName);
        const readableP = E(agent).lookup(archiveNamePath);
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        for await (const chunk of iterateBytesReader(readableP)) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        const archiveBytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          archiveBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        await runArchiveBytes(archiveBytes, powersP, programArguments);
      } else {
        // Build a source-only archive on the fly from the file path.
        const readPowers = makeReadPowers({ fs, url, crypto, path });
        const moduleLocation = url.pathToFileURL(
          path.resolve(/** @type {string} */ (filePath)),
        ).href;
        const archiveBytes = await makeCompartmentArchive(
          readPowers,
          moduleLocation,
          { parserForLanguage: sourceParserForLanguage },
        );
        await runArchiveBytes(archiveBytes, powersP, programArguments);
      }
    },
  );
};
