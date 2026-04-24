/* global process */
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
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    content = new TextDecoder('utf-8').decode(bytes);
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const namePath = parsePetNamePath(name);
    await E(agent).writeText(namePath, content);
  });
};
