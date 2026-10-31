// @ts-check

import { parseLocator } from '@endo/daemon/locator.js';
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { sha256 } from '@endo/sha256';

/** @typedef {{format: 'endo-floot', version: 1, controller: string, stt?: string, tts?: string}} FlootTransfer */

/**
 * Validate everything before writing anything to the local inventory.
 * @param {string} text
 * @returns {FlootTransfer}
 */
export const parseFlootTransfer = text => {
  if (new TextEncoder().encode(text).length > 16_384)
    throw Error('Floot import is too large');
  const value = JSON.parse(text);
  if (
    !value ||
    value.format !== 'endo-floot' ||
    value.version !== 1 ||
    typeof value.controller !== 'string'
  ) {
    throw Error('Expected an Endo Floot export (version 1)');
  }
  for (const key of Object.keys(value)) {
    if (!['format', 'version', 'controller', 'stt', 'tts'].includes(key))
      throw Error(`Unknown Floot export field: ${key}`);
  }
  for (const key of ['controller', 'stt', 'tts']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string') throw Error(`Invalid ${key} locator`);
      parseLocator(value[key]);
    }
  }
  return harden(value);
};
harden(parseFlootTransfer);

/**
 * @param {any} powers
 * @param {{profilePath: string[], audioPath?: string[], ttsPath?: string[]}} paths
 */
export const exportFlootObjects = async (powers, paths) => {
  /** @type {FlootTransfer} */
  const value = {
    format: 'endo-floot',
    version: 1,
    controller: await E(powers).locateWithHints(...paths.profilePath),
  };
  if (paths.audioPath?.length)
    value.stt = await E(powers).locateWithHints(...paths.audioPath);
  if (paths.ttsPath?.length)
    value.tts = await E(powers).locateWithHints(...paths.ttsPath);
  const text = JSON.stringify(value, null, 2);
  parseFlootTransfer(text);
  return text;
};
harden(exportFlootObjects);

/**
 * Repeat imports repair a partially imported bundle, without overwriting names.
 * @param {any} powers
 * @param {string} text
 */
export const importFlootObjects = async (powers, text) => {
  const value = parseFlootTransfer(text);
  const canonical = JSON.stringify([
    value.controller,
    value.stt || '',
    value.tts || '',
  ]);
  const digest = [...sha256(new TextEncoder().encode(canonical))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  const name = `floot-import-${digest.slice(0, 32)}`;
  if (!(await E(powers).has(name))) await E(powers).makeDirectory(name);
  const directory = await E(powers).lookup(name);
  for (const key of /** @type {const} */ (['controller', 'stt', 'tts'])) {
    const locator = value[key];
    if (!locator) {
      // Optional voice objects are absent in a text-only export.
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await E(directory).has(key)) {
      // eslint-disable-next-line no-await-in-loop
      const existing = parseLocator(await E(directory).locate(key));
      const incoming = parseLocator(locator);
      if (
        existing.number !== incoming.number ||
        existing.node !== incoming.node
      )
        throw Error('Import destination already holds another object');
    } else {
      // eslint-disable-next-line no-await-in-loop
      await E(powers).adoptFromLocator(locator, [name, key]);
    }
  }
  return harden({
    profilePath: [name, 'controller'],
    ...(value.stt ? { audioPath: [name, 'stt'] } : {}),
    ...(value.tts ? { ttsPath: [name, 'tts'] } : {}),
  });
};
harden(importFlootObjects);
