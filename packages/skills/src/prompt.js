// @ts-check

/** @import { Skill } from './types.js' */

import harden from '@endo/harden';

import { splitFrontmatter } from './parse.js';

const SKILL_COMMAND_PATTERN = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/;

/** @param {string} text */
const escapeXml = text =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Render the compact skill list for a system prompt: each skill's name,
 * description, and location, with instructions to read a skill's file when a
 * task matches. Skill bodies stay on disk until the model reads them. Skills
 * marked `disable-model-invocation` are left out; with nothing to list the
 * result is empty, so the caller can append it unconditionally.
 *
 * @param {readonly Skill[]} skills
 * @returns {string}
 */
export const formatSkillsForPrompt = skills => {
  const visible = skills.filter(skill => !skill.disableModelInvocation);
  if (visible.length === 0) {
    return '';
  }
  return [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (the parent of SKILL.md) and use that absolute path in tool calls.',
    '',
    '<available_skills>',
    ...visible.flatMap(skill => [
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n');
};
harden(formatSkillsForPrompt);

/**
 * Recognize `/skill:<name> [arguments]` at the start of a message.
 *
 * @param {string} text
 * @returns {{ name: string, args: string } | undefined}
 */
export const parseSkillCommand = text => {
  const match = text.trim().match(SKILL_COMMAND_PATTERN);
  if (!match) {
    return undefined;
  }
  return harden({ name: match[1], args: (match[2] ?? '').trim() });
};
harden(parseSkillCommand);

/**
 * Expand a `/skill:<name>` message into the skill's body, so the model has the
 * skill even when it would not have read it on its own. The body is wrapped in
 * a `<skill>` element naming its location, and any arguments follow it. A
 * message that is not a skill command is returned unchanged. An unknown name
 * is an error rather than a message sent as typed.
 *
 * @param {object} options
 * @param {string} options.text the user's message
 * @param {readonly Skill[]} options.skills
 * @param {(filePath: string) => Promise<string>} options.readText
 * @returns {Promise<string>}
 */
export const expandSkillCommand = async ({ text, skills, readText }) => {
  await null;
  const command = parseSkillCommand(text);
  if (!command) {
    return text;
  }
  const skill = skills.find(candidate => candidate.name === command.name);
  if (!skill) {
    throw Error(`Unknown skill ${JSON.stringify(command.name)}`);
  }
  const { body } = splitFrontmatter(await readText(skill.filePath));
  const block = [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">`,
    `References are relative to ${skill.baseDir}.`,
    '',
    body,
    '</skill>',
  ].join('\n');
  return command.args ? `${block}\n\n${command.args}` : block;
};
harden(expandSkillCommand);
