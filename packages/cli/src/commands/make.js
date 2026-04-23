/* global process */

import os from 'os';
import path from 'path';
import url from 'url';

import bundleSource from '@endo/bundle-source';
import { makeReaderRef } from '@endo/daemon';
import { E } from '@endo/far';
import { withEndoAgent } from '../context.js';
import { parseOptionalPetNamePath } from '../pet-name.js';
import { randomHex16 } from '../random.js';

const textEncoder = new TextEncoder();

export const makeCommand = async ({
  filePath,
  importPath,
  resultName,
  bundleName,
  archiveName,
  workerName,
  agentNames,
  powersName,
  env,
}) => {
  await null;
  if (filePath !== undefined && importPath !== undefined) {
    console.error('Specify only one of [file] or --UNCONFINED <file>');
    process.exitCode = 1;
    return;
  }
  if (bundleName !== undefined && archiveName !== undefined) {
    console.error('Specify only one of --bundle or --archive');
    process.exitCode = 1;
    return;
  }
  if (
    filePath === undefined &&
    importPath === undefined &&
    bundleName === undefined &&
    archiveName === undefined
  ) {
    console.error(
      'Specify at least one of [file], --archive <name>, --bundle <name>, or --UNCONFINED <file>',
    );
    process.exitCode = 1;
    return;
  }

  const resultPath = parseOptionalPetNamePath(resultName);

  /** @type {import('@endo/eventual-send').FarRef<import('@endo/stream').Reader<string>> | undefined} */
  let bundleReaderRef;
  /** @type {string | undefined} */
  let temporaryBundleName;
  if (filePath !== undefined) {
    if (bundleName === undefined) {
      // TODO alternately, make a temporary session-scoped GC pet store
      // overshadowing the permanent one, which gets implicitly dropped
      // when this CLI CapTP session ends.
      temporaryBundleName = `tmp-bundle-${await randomHex16()}`;
      bundleName = temporaryBundleName;
    }
    const bundle = await bundleSource(filePath);
    const bundleText = JSON.stringify(bundle);
    const bundleBytes = textEncoder.encode(bundleText);
    bundleReaderRef = makeReaderRef([bundleBytes]);
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;
    // Prepare a bundle, with the given name.
    if (bundleReaderRef !== undefined) {
      await E(agent).storeBlob(bundleReaderRef, bundleName);
    }

    let resultP;
    if (importPath !== undefined) {
      resultP = E(agent).makeUnconfined(
        workerName,
        url.pathToFileURL(path.resolve(importPath)).href,
        { powersName, resultName: resultPath, env },
      );
    } else if (archiveName !== undefined) {
      resultP = E(agent).makeArchive(workerName, archiveName, {
        powersName,
        resultName: resultPath,
        env,
      });
    } else {
      resultP = E(agent).makeBundle(workerName, bundleName, {
        powersName,
        resultName: resultPath,
        env,
      });
    }
    let result;
    try {
      result = await resultP;
      console.log(result);
    } finally {
      if (temporaryBundleName) {
        await E(agent).remove(temporaryBundleName);
      }
    }
    return result;
  });
};
