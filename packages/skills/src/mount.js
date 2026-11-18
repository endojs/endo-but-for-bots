// @ts-check

/** @import { LoadSkillsResult, SkillSource } from './types.js' */

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

import { loadSkills } from './load.js';

/** The pet name under which an agent holds its skill source mounts. */
export const AGENT_SKILLS_PET_NAME = 'agent-skills';
harden(AGENT_SKILLS_PET_NAME);

/**
 * Expose a read-only mount of a directory of skill directories as a skill
 * source. Locations are pet-name paths, for example
 * `agent-skills/20-pi-user/my-skill/SKILL.md`, which a confined agent's model
 * can pass to `readText` through the same powers that hold the mount.
 *
 * @param {object} options
 * @param {unknown} options.mount an EndoMount (or remote reference to one)
 * @param {readonly string[]} options.petNamePath where the agent holds the
 *   mount, used for locations and as the source label
 * @returns {SkillSource}
 */
export const makeMountSkillSource = ({ mount, petNamePath }) => {
  const prefix = petNamePath.join('/');
  return harden({
    label: prefix,
    list: async () => {
      /** @type {string[]} */
      const names = await E(/** @type {any} */ (mount)).list();
      return names;
    },
    /** @param {string} entryName */
    readSkillText: async entryName => {
      const remote = /** @type {any} */ (mount);
      if (!(await E(remote).has(entryName, 'SKILL.md'))) {
        return undefined;
      }
      /** @type {string} */
      const text = await E(remote).readText([entryName, 'SKILL.md']);
      return text;
    },
    /** @param {string} entryName */
    locate: entryName =>
      harden({
        filePath: `${prefix}/${entryName}/SKILL.md`,
        baseDir: `${prefix}/${entryName}`,
      }),
  });
};
harden(makeMountSkillSource);

/**
 * List the skill sources an agent holds under `agent-skills`, in entry-name
 * order, which is precedence order: a later source overrides an earlier skill
 * of the same name. An agent without the name has no sources.
 *
 * @param {unknown} powers the agent's EndoGuest or EndoHost
 * @param {object} [options]
 * @param {string} [options.petName]
 * @returns {Promise<SkillSource[]>}
 */
export const listAgentSkillSources = async (
  powers,
  { petName = AGENT_SKILLS_PET_NAME } = {},
) => {
  const remote = /** @type {any} */ (powers);
  if (!(await E(remote).has(petName))) {
    return [];
  }
  /** @type {string[]} */
  const entryNames = await E(remote).list(petName);
  return Promise.all(
    [...entryNames].sort().map(async entryName => {
      const mount = await E(remote).lookup([petName, entryName]);
      return makeMountSkillSource({ mount, petNamePath: [petName, entryName] });
    }),
  );
};
harden(listAgentSkillSources);

/**
 * Load every skill an agent holds under `agent-skills`.
 *
 * @param {unknown} powers
 * @param {object} [options]
 * @param {string} [options.petName]
 * @returns {Promise<LoadSkillsResult>}
 */
export const loadAgentSkills = async (powers, options) =>
  loadSkills(await listAgentSkillSources(powers, options));
harden(loadAgentSkills);
