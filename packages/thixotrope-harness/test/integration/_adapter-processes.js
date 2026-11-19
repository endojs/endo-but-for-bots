// @ts-check
/**
 * Find a native resource's adapter process under a served state (core
 * request CC-092's workaround, `designs/m6-interfaces.md` 3.11 and 12):
 * the daemon's `status()` does not name adapter processes, so a test finds
 * the process among `processesUnder(root)` whose command line names one of
 * the state's bundles (`<root>/bundles/<digest>.cjs`, the launcher's
 * `argv[3]`) whose source is the installation's ephemeral bundle, told by a
 * text that only that loader holds (its exported loader name).
 *
 * One helper for every lane that kills or checks one adapter alone (the
 * environments adapter, the speech engines' adapter). AVA skips files
 * starting with an underscore.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { processesUnder } from '../template/index.js';

/** @type {Map<string, boolean>} */
const bundleHolds = new Map();

/**
 * Whether the bundle at `file` contains `needle` (cached per file and
 * needle: bundles are content-addressed and never change).
 * @param {string} file
 * @param {string} needle
 */
const bundleContains = (file, needle) => {
  const key = `${file}\0${needle}`;
  let held = bundleHolds.get(key);
  if (held === undefined) {
    try {
      held = readFileSync(file, 'utf8').includes(needle);
    } catch {
      held = false;
    }
    bundleHolds.set(key, held);
  }
  return held;
};

/**
 * The adapter processes of one installation: those under `root` whose
 * command line names a bundle of the state that contains `needle`.
 * @param {string} root the served state directory
 * @param {string} needle a text only the installation's ephemeral bundle
 *   holds (for example its loader's exported name)
 * @returns {{ pid: number, command: string }[]}
 */
export const adapterProcesses = (root, needle) => {
  const bundles = `${path.join(root, 'bundles')}/`;
  return processesUnder(root).filter(({ command }) =>
    command
      .split(/\s+/)
      .some(
        word =>
          word.startsWith(bundles) &&
          word.endsWith('.cjs') &&
          bundleContains(word, needle),
      ),
  );
};
harden(adapterProcesses);

/**
 * The one adapter process of an installation, or undefined when none runs
 * (the kit starts it at the next manager call). Throws when two match.
 * @param {string} root
 * @param {string} needle
 */
export const adapterProcess = (root, needle) => {
  const found = adapterProcesses(root, needle);
  if (found.length > 1)
    throw Error(
      `${found.length} adapter processes match ${needle}: ${found.map(p => p.pid).join(', ')}`,
    );
  return found[0];
};
harden(adapterProcess);
