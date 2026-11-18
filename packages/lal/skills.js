// @ts-nocheck - E() generics don't compose cleanly with FarRef + JSDoc
/* eslint-disable no-await-in-loop */
/**
 * Agent Skills for a Lal worker.
 *
 * A worker loads the skills it holds under `agent-skills` once per
 * incarnation and lists them in its system prompt. It follows the
 * `agent-skills` directory: when an entry is added or removed, the list is
 * reloaded before the next round, so a round already running keeps the
 * prompt it started with. Edits inside a mounted directory take effect at the
 * next incarnation. `/skill:<name> [args]` messages expand to the skill's
 * current body, reread at expansion time.
 *
 * Diagnostics go to the worker's log, never to the model.
 */

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { AGENT_SKILLS_PET_NAME, loadAgentSkills } from '@endo/skills/mount.js';
import {
  expandSkillCommand,
  formatSkillsForPrompt,
  parseSkillCommand,
} from '@endo/skills/prompt.js';

/** @import { Skill } from '@endo/skills/types.js' */

/** The most skills a Lal system prompt lists. */
export const MAX_PROMPT_SKILLS = 200;
harden(MAX_PROMPT_SKILLS);

/**
 * How Lal's model reads a skill: through its `readText` tool and the
 * pet-name path the skill's location names.
 */
export const LAL_SKILLS_READ_HINT = [
  'When a task matches a skill\'s description, read the skill with readText(<location without the trailing "/SKILL.md">, "SKILL.md"), for example readText("agent-skills/10-user/my-skill", "SKILL.md").',
  'When a skill file references a relative path, resolve it against the skill\'s directory, the location without "/SKILL.md", and pass that directory path and the file name to readText.',
].join('\n');
harden(LAL_SKILLS_READ_HINT);

/**
 * Order skills by precedence, highest first: a skill from a later source (by
 * entry name under `agent-skills`) outranks one from an earlier source, and
 * skills within a source keep name order. Keep the first `max`.
 *
 * @param {readonly Skill[]} skills
 * @param {number} [max]
 * @returns {{ listed: Skill[], omitted: Skill[] }}
 */
export const capSkills = (skills, max = MAX_PROMPT_SKILLS) => {
  const visible = skills.filter(skill => !skill.disableModelInvocation);
  const ordered = [...visible].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source < b.source ? 1 : -1;
    }
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  return { listed: ordered.slice(0, max), omitted: ordered.slice(max) };
};
harden(capSkills);

/**
 * @param {object} options
 * @param {any} options.powers the worker's guest powers
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {(...args: unknown[]) => void} [options.warn]
 * @param {number} [options.maxSkills]
 */
export const makeAgentSkills = ({
  powers,
  log = console.log,
  warn = console.warn,
  maxSkills = MAX_PROMPT_SKILLS,
}) => {
  /** @type {readonly Skill[]} */
  let skills = [];
  let promptSection = '';
  /** @type {string} */
  let loadedEntries = '';
  let dirty = false;
  let stopped = false;

  const listEntries = async () => {
    if (!(await E(powers).has(AGENT_SKILLS_PET_NAME))) {
      return '';
    }
    /** @type {string[]} */
    const names = await E(powers).list(AGENT_SKILLS_PET_NAME);
    return JSON.stringify([...names].sort());
  };

  const load = async () => {
    const entries = await listEntries();
    const result = await loadAgentSkills(powers);
    for (const diagnostic of result.diagnostics) {
      const where = diagnostic.entryName
        ? `${diagnostic.source}/${diagnostic.entryName}`
        : diagnostic.source;
      warn(`[skills] ${diagnostic.severity} ${where}: ${diagnostic.message}`);
    }
    const { listed, omitted } = capSkills(result.skills, maxSkills);
    if (omitted.length > 0) {
      warn(
        `[skills] Listing ${listed.length} skills; ${omitted.length} more omitted from the prompt: ${omitted
          .map(skill => skill.name)
          .join(', ')}`,
      );
    }
    skills = result.skills;
    promptSection = formatSkillsForPrompt(listed, {
      readHint: LAL_SKILLS_READ_HINT,
    });
    loadedEntries = entries;
    log(`[skills] Loaded ${result.skills.length} skills`);
  };

  /**
   * Load once for this incarnation. A failure leaves the agent without
   * skills rather than without a worker.
   */
  const start = async () => {
    try {
      await load();
    } catch (error) {
      warn('[skills] Could not load skills:', error);
    }
  };

  /**
   * Called between rounds. When the `agent-skills` entries changed since the
   * last load, reload and report whether the prompt section changed.
   *
   * @returns {Promise<boolean>}
   */
  const refresh = async () => {
    if (!dirty) return false;
    dirty = false;
    const before = promptSection;
    try {
      if ((await listEntries()) === loadedEntries) {
        return false;
      }
      await load();
    } catch (error) {
      warn('[skills] Could not reload skills:', error);
      return false;
    }
    return promptSection !== before;
  };

  const followDirectory = async () => {
    const changes = iterateReader(
      E(powers).followNameChanges(AGENT_SKILLS_PET_NAME),
    );
    for await (const change of changes) {
      if (stopped) break;
      if (change) dirty = true;
    }
  };

  /**
   * Follow the agent's names for `agent-skills` itself appearing or going,
   * and the directory's entries while it exists. Every change only marks the
   * snapshot stale; `refresh` decides at the next round.
   */
  const follow = async () => {
    try {
      /** @type {Promise<void> | undefined} */
      let following;
      if (await E(powers).has(AGENT_SKILLS_PET_NAME)) {
        following = followDirectory().catch(() => {});
      }
      const rootChanges = iterateReader(E(powers).followNameChanges());
      for await (const change of rootChanges) {
        if (stopped) break;
        const name = change.add ?? change.remove;
        if (name === AGENT_SKILLS_PET_NAME) {
          dirty = true;
          if (change.add !== undefined && following === undefined) {
            following = followDirectory()
              .catch(() => {})
              .finally(() => {
                following = undefined;
              });
          }
        }
      }
    } catch (error) {
      warn('[skills] Stopped following agent-skills:', error);
    }
  };

  /**
   * Read a skill file by its pet-name location through the mount that holds
   * it.
   *
   * @param {string} filePath
   */
  const readSkillFile = async filePath => {
    const skill = skills.find(candidate => candidate.filePath === filePath);
    if (!skill) {
      throw Error(`No skill at ${JSON.stringify(filePath)}`);
    }
    const mountPath = skill.source.split('/');
    const relative = filePath.slice(skill.source.length + 1).split('/');
    const mount = await E(powers).lookup(mountPath);
    /** @type {string} */
    const text = await E(mount).readText(relative);
    return text;
  };

  /**
   * Expand a `/skill:<name> [args]` message to the skill's current body.
   * Returns `undefined` for a message that is not a skill command, and throws
   * for an unknown skill.
   *
   * @param {string} text
   * @returns {Promise<string | undefined>}
   */
  const expand = async text => {
    if (!parseSkillCommand(text)) {
      return undefined;
    }
    return expandSkillCommand({ text, skills, readText: readSkillFile });
  };

  return harden({
    start,
    follow,
    refresh,
    expand,
    stop: () => {
      stopped = true;
    },
    /** The current skills section of the system prompt, possibly empty. */
    promptSection: () => promptSection,
    /** Every loaded skill, including ones hidden from the prompt. */
    skills: () => skills,
  });
};
harden(makeAgentSkills);
