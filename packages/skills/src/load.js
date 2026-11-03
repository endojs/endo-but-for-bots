// @ts-check

/**
 * @import {
 *   LoadSkillsResult,
 *   Skill,
 *   SkillDiagnostic,
 *   SkillSource,
 * } from './types.js'
 */

import harden from '@endo/harden';

import { parseSkill } from './parse.js';

/** The longest `SKILL.md` read; a larger file is not a skill. */
export const MAX_SKILL_FILE_LENGTH = 1024 * 1024;
harden(MAX_SKILL_FILE_LENGTH);

/**
 * Load the skill directories of each source. A later source overrides an
 * earlier one on the same name, so the caller orders sources from lowest to
 * highest precedence; the override is reported as a warning. An unreadable
 * source or file yields a diagnostic and never prevents the others loading.
 *
 * @param {readonly SkillSource[]} sources
 * @returns {Promise<LoadSkillsResult>}
 */
export const loadSkills = async sources => {
  /** @type {SkillDiagnostic[]} */
  const diagnostics = [];

  const sourceResults = await Promise.all(
    sources.map(async source => {
      await null;
      const { label } = source;
      /** @type {readonly string[]} */
      let entryNames;
      try {
        entryNames = await source.list();
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          source: label,
          message: String(error),
        });
        return [];
      }
      const loaded = await Promise.all(
        [...entryNames]
          .filter(entryName => !entryName.startsWith('.'))
          .sort()
          .map(async entryName => {
            await null;
            /** @type {string | undefined} */
            let text;
            try {
              text = await source.readSkillText(entryName);
            } catch (error) {
              diagnostics.push({
                severity: 'error',
                source: label,
                entryName,
                message: String(error),
              });
              return undefined;
            }
            if (text === undefined) {
              return undefined;
            }
            if (text.length > MAX_SKILL_FILE_LENGTH) {
              diagnostics.push({
                severity: 'error',
                source: label,
                entryName,
                message: `SKILL.md exceeds ${MAX_SKILL_FILE_LENGTH} characters`,
              });
              return undefined;
            }
            const { filePath, baseDir } = source.locate(entryName);
            const parsed = parseSkill({
              directoryName: entryName,
              text,
              filePath,
              baseDir,
              source: label,
            });
            diagnostics.push(...parsed.diagnostics);
            return parsed.skill;
          }),
      );
      return loaded.filter(skill => skill !== undefined);
    }),
  );

  /** @type {Map<string, Skill>} */
  const skills = new Map();
  for (const skill of sourceResults.flat()) {
    const shadowed = skills.get(skill.name);
    if (shadowed) {
      diagnostics.push({
        severity: 'warning',
        source: skill.source,
        entryName: skill.name,
        message: `skill ${JSON.stringify(skill.name)} overrides the one in ${shadowed.source}`,
      });
    }
    skills.set(skill.name, skill);
  }

  return harden({
    // Map keys are unique, so no two names compare equal.
    skills: [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    diagnostics,
  });
};
harden(loadSkills);
