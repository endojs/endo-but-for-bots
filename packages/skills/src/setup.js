// @ts-check

import { stat } from 'node:fs/promises';

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

import { AGENT_SKILLS_PET_NAME } from './mount.js';
import { listLabeledSkillDirectories } from './node.js';

/**
 * Entry names the setup script writes: a two-digit precedence prefix and the
 * label of a conventional directory. Rerunning setup replaces exactly these
 * and leaves any other entry under `agent-skills` alone.
 */
const SETUP_ENTRY_PATTERN =
  /^\d{2}-(?:claude|codex|pi|agents)-(?:user|project)(?:-\d+)?$/;

/**
 * @param {string} entryName
 * @returns {boolean}
 */
export const isSetupEntryName = entryName =>
  SETUP_ENTRY_PATTERN.test(entryName);
harden(isSetupEntryName);

/** @param {string} directory */
const isDirectory = async directory => {
  await null;
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Plan one read-only mount per conventional skill directory that exists, in
 * precedence order. Entry names carry a two-digit prefix so that sorting them
 * reproduces that order: project sources sort after user sources.
 *
 * @param {object} options
 * @param {string} options.homeDirectory
 * @param {string} options.workingDirectory
 * @param {boolean} [options.crossHarness]
 * @returns {Promise<ReadonlyArray<{ entryName: string, directory: string }>>}
 */
export const planSkillMounts = async options => {
  await null;
  const labeled = await listLabeledSkillDirectories(options);
  const present = await Promise.all(
    labeled.map(async entry =>
      (await isDirectory(entry.directory)) ? entry : undefined,
    ),
  );
  return harden(
    labeled.flatMap(({ label, directory }, index) =>
      present[index]
        ? [
            {
              entryName: `${String(index).padStart(2, '0')}-${label}`,
              directory,
            },
          ]
        : [],
    ),
  );
};
harden(planSkillMounts);

/**
 * Write the planned mounts into `<agentName>/agent-skills` through a host,
 * creating the directory when absent and first removing the entries a
 * previous run wrote. Every mount is read-only.
 *
 * @param {object} options
 * @param {unknown} options.host the user's EndoHost
 * @param {string} options.agentName the agent's pet name in the host
 * @param {ReadonlyArray<{ entryName: string, directory: string }>} options.mounts
 * @param {string} [options.petName]
 * @returns {Promise<{ removed: string[], added: string[] }>}
 */
export const installSkillMounts = async ({
  host,
  agentName,
  mounts,
  petName = AGENT_SKILLS_PET_NAME,
}) => {
  await null;
  const remote = /** @type {any} */ (host);
  const directoryPath = [agentName, petName];
  if (!(await E(remote).has(...directoryPath))) {
    await E(remote).makeDirectory(directoryPath);
  }
  /** @type {string[]} */
  const existing = await E(remote).list(...directoryPath);
  const removed = existing.filter(isSetupEntryName);
  for (const entryName of removed) {
    // eslint-disable-next-line no-await-in-loop
    await E(remote).remove(...directoryPath, entryName);
  }
  for (const { entryName, directory } of mounts) {
    // eslint-disable-next-line no-await-in-loop
    await E(remote).provideMount(directory, [...directoryPath, entryName], {
      readOnly: true,
    });
  }
  return harden({ removed, added: mounts.map(({ entryName }) => entryName) });
};
harden(installSkillMounts);
