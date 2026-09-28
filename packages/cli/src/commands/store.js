import fs from 'fs';
import os from 'os';

import { makeNodeReader } from '@endo/stream-node';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { concatBytes } from '@endo/bytes/concat.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @param {AsyncIterable<Uint8Array>} reader
 */
const asyncConcat = async reader => {
  const chunks = [];
  for await (const chunk of reader) {
    chunks.push(chunk);
  }
  return concatBytes(chunks);
};

export const store = async ({
  name,
  agentNames,
  storePath,
  storeStdin,
  storeText,
  storeTextStdin,
  storeJson,
  storeJsonStdin,
  storeBigInt,
  storeLocator,
  storeLocatorFile,
}) => {
  const modes = {
    storePath,
    storeStdin,
    storeText,
    storeTextStdin,
    storeJson,
    storeJsonStdin,
    storeBigInt,
    storeLocator,
    storeLocatorFile,
  };
  const selectedModes = Object.entries(modes).filter(
    ([_modeName, value]) => value !== undefined,
  );
  const selectedModeNames = selectedModes.map(([modeName]) => modeName);
  if (selectedModes.length !== 1) {
    // Usage error should be reported without trace.
    // eslint-disable-next-line no-throw-literal
    throw `Must provide exactly one store flag. Got flags for: (${selectedModeNames.join(
      ', ',
    )})`;
  }

  const parsedName = parsePetNamePath(name);

  // Read a bearer locator from stdin (`--locator -`) or a file
  // (`--locator-file`), so it never has to appear on the command line (and
  // in shell history or `ps`). A literal `--locator <url>` is accepted for
  // locators that are not bearers.
  let locator;
  if (storeLocator !== undefined || storeLocatorFile !== undefined) {
    if (storeLocatorFile !== undefined || storeLocator === '-') {
      if (storeLocatorFile !== undefined) {
        locator = await fs.promises.readFile(storeLocatorFile, 'utf-8');
      } else {
        process.stdin.setEncoding('utf-8');
        const chunks = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        locator = chunks.join('');
      }
    } else {
      locator = storeLocator;
    }
    locator = locator.trim();
    if (locator === '') {
      // Usage error should be reported without trace.
      // eslint-disable-next-line no-throw-literal
      throw `store: no locator given; pipe it to --locator - or pass --locator-file`;
    }
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;
    if (locator !== undefined) {
      // The daemon resolves the value the locator names before it commits
      // the pet name, and accepts any capability URL (endo:// or the https
      // fragment form).
      await E(agent).adoptFromLocator(locator, parsedName);
    } else if (storeText !== undefined) {
      await E(agent).storeValue(storeText, parsedName);
    } else if (storeJson !== undefined) {
      await E(agent).storeValue(JSON.parse(storeJson), parsedName);
    } else if (storeBigInt !== undefined) {
      await E(agent).storeValue(BigInt(storeBigInt), parsedName);
    } else if (storeTextStdin !== undefined) {
      const reader = makeNodeReader(process.stdin);
      const bytes = await asyncConcat(reader);
      const text = decodeUtf8(bytes);
      await E(agent).storeValue(text, parsedName);
    } else if (storeJsonStdin !== undefined) {
      const reader = makeNodeReader(process.stdin);
      const bytes = await asyncConcat(reader);
      const text = decodeUtf8(bytes);
      await E(agent).storeValue(JSON.parse(text), parsedName);
    } else if (storeStdin !== undefined) {
      const reader = makeNodeReader(process.stdin);
      const readerRef = bytesReaderFromIterator(reader);
      await E(agent).storeBlob(readerRef, parsedName);
    } else if (storePath !== undefined) {
      const nodeReadStream = fs.createReadStream(storePath);
      const reader = makeNodeReader(nodeReadStream);
      const readerRef = bytesReaderFromIterator(reader);
      await E(agent).storeBlob(readerRef, parsedName);
    }
  });
};
