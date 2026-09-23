import os from 'os';
import fs from 'fs/promises';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Read a bearer locator from a file or standard input, so it never has
 * to appear on the command line (and in shell history or `ps`).
 *
 * @param {string | undefined} file
 */
const readLocator = async file => {
  if (file !== undefined && file !== '-') {
    return (await fs.readFile(file, 'utf-8')).trim();
  }
  process.stdin.setEncoding('utf-8');
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('').trim();
};

/**
 * Adopt the value an `endo://` locator names under a local pet name. The
 * daemon connects over a route the locator's hints and the installed
 * networks both support, authenticates the peer, and resolves the value
 * before it commits the name.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} [args.file]
 * @param {string[]} [args.agentNames]
 */
export const adoptLocatorCommand = async ({ name, file, agentNames }) => {
  const locator = await readLocator(file);
  if (locator === '') {
    throw Error(
      'adopt-locator: no locator given; pipe it on stdin or pass --file',
    );
  }
  return withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).adoptFromLocator(locator, parsePetNamePath(name));
  });
};
