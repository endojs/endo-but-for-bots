/* global process */
import { Buffer } from 'node:buffer';
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Write text content to a path within a mount.
 *
 * Reads text from stdin and writes it to the target path.
 * For multi-segment paths like `project/src/index.js`, navigates through
 * mounts via the pet-name directory's `writeText` delegation chain.
 *
 * @param {object} options
 * @param {string} options.name - Slash-delimited pet name path.
 * @param {string} [options.text] - Text content (alternative to stdin).
 * @param {boolean} [options.useStdin] - Read content from stdin.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const writeText = async ({ name, text, useStdin, agentNames }) => {
  let content = text;
  if (useStdin || content === undefined) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks).toString('utf-8');
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const namePath = parsePetNamePath(name);
    await E(agent).writeText(namePath, content);
  });
};
