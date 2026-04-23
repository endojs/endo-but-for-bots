/* global globalThis, process */
import url from 'url';
import os from 'os';
import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import bundleSource from '@endo/bundle-source';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

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

export const run = async ({
  filePath,
  args,
  bundleName,
  archiveName,
  importPath,
  powersName,
  agentNames,
  env = {},
}) => {
  if (
    filePath === undefined &&
    importPath === undefined &&
    bundleName === undefined &&
    archiveName === undefined
  ) {
    console.error(
      'Specify at least one of --file, --archive, --bundle, or --UNCONFINED',
    );
    process.exitCode = 1;
    return;
  }
  if (bundleName !== undefined && archiveName !== undefined) {
    console.error('Specify either --bundle or --archive, not both');
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
        powersP = E(agent).provideGuest(powersName);
      }

      if (importPath !== undefined) {
        if (bundleName !== undefined || archiveName !== undefined) {
          console.error(
            'Must specify either --archive/--bundle or --UNCONFINED, not both',
          );
          process.exitCode = 1;
          return;
        }
        if (filePath !== undefined) {
          args.unshift(filePath);
        }

        const importUrl = url.pathToFileURL(importPath).href;
        const namespace = await import(importUrl);
        const result = await namespace.main(powersP, ...args);
        if (result !== undefined) {
          console.log(result);
        }
      } else if (archiveName !== undefined) {
        if (filePath !== undefined) {
          args.unshift(filePath);
        }
        // Stream the archive bytes from the daemon.
        const archiveNamePath = parsePetNamePath(archiveName);
        const readableP = E(agent).lookup(archiveNamePath);
        const { makeRefReader } = await import('@endo/daemon');
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        for await (const chunk of makeRefReader(
          await E(readableP).streamBase64(),
        )) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        const archiveBytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          archiveBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const [{ parseArchive }, { defaultParserForLanguage }] =
          await Promise.all([
            import('@endo/compartment-mapper'),
            import('@endo/compartment-mapper/import-archive-all-parsers.js'),
          ]);
        const application = await parseArchive(archiveBytes, '<archive>', {
          parserForLanguage: defaultParserForLanguage,
        });
        const { namespace } = await application.import({
          globals: endowments,
        });
        const result = await /** @type {{main: Function}} */ (namespace).main(
          powersP,
          ...args,
        );
        if (result !== undefined) {
          console.log(result);
        }
      } else {
        /** @type {any} */
        let bundle;
        if (bundleName !== undefined) {
          if (importPath !== undefined) {
            console.error(
              'Must specify either --bundle or --UNCONFINED, not both',
            );
            process.exitCode = 1;
            return;
          }
          if (filePath !== undefined) {
            args.unshift(filePath);
          }

          const bundleNamePath = parsePetNamePath(bundleName);
          const readableP = E(agent).lookup(bundleNamePath);
          const bundleText = await E(readableP).text();
          bundle = JSON.parse(bundleText);
        } else {
          bundle = await bundleSource(filePath);
        }

        // We defer importing the import-bundle machinery to this in order to
        // avoid an up-front cost for workers that never use importBundle.
        const { importBundle } = await import('@endo/import-bundle');
        const namespace = await importBundle(bundle, {
          endowments,
        });
        const result = await namespace.main(powersP, ...args);
        if (result !== undefined) {
          console.log(result);
        }
      }
    },
  );
};
