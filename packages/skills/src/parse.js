// @ts-check

/** @import { Skill, SkillDiagnostic } from './types.js' */

import harden from '@endo/harden';

export const MAX_NAME_LENGTH = 64;
harden(MAX_NAME_LENGTH);
export const MAX_DESCRIPTION_LENGTH = 1024;
harden(MAX_DESCRIPTION_LENGTH);
export const MAX_COMPATIBILITY_LENGTH = 500;
harden(MAX_COMPATIBILITY_LENGTH);

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n?---(?:\n|$)/;
const KEY_PATTERN = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/;
const QUOTED_PATTERN = /^(["'])(.*)\1$/;
const BLOCK_SCALAR_PATTERN = /^([|>])[+-]?$/;
const INDENTED_PATTERN = /^[ \t]+\S/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FLOW_PATTERN = /^[[{]/;

/** @param {string} text */
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

/** @param {string} value */
const unquote = value => {
  const quoted = value.match(QUOTED_PATTERN);
  return quoted ? quoted[2] : value;
};

/**
 * Split a markdown file into its frontmatter text and body. A file whose
 * opening `---` is never closed is all body.
 *
 * @param {string} text
 * @returns {{ frontmatter: string | undefined, body: string }}
 */
export const splitFrontmatter = text => {
  const normalized = normalize(text);
  const match = normalized.match(FRONTMATTER_PATTERN);
  if (!match) {
    return harden({ frontmatter: undefined, body: normalized.trim() });
  }
  return harden({
    frontmatter: match[1],
    body: normalized.slice(match[0].length).trim(),
  });
};
harden(splitFrontmatter);

/**
 * Read the YAML subset skill frontmatter uses: top-level `key: value` pairs
 * with optional quotes, `|` and `>` block scalars, and one level of nested
 * `key: value` pairs under a key with no value (for `metadata`). Anything else
 * is ignored rather than rejected, so foreign skills still load; each ignored
 * construct is reported to `onIgnored` so the caller can warn.
 *
 * @param {string} frontmatter
 * @param {(message: string) => void} [onIgnored]
 * @returns {Record<string, string | Record<string, string>>}
 */
export const parseFrontmatter = (frontmatter, onIgnored = () => {}) => {
  /** @type {Record<string, string | Record<string, string>>} */
  const fields = {};
  const lines = frontmatter.split('\n');
  let index = 0;
  while (index < lines.length) {
    const match = lines[index].match(KEY_PATTERN);
    index += 1;
    const [, key, rawValue] = match ?? [];
    /** @type {string[]} */
    const continuation = [];
    while (
      index < lines.length &&
      (INDENTED_PATTERN.test(lines[index]) || !lines[index].trim())
    ) {
      continuation.push(lines[index]);
      index += 1;
    }
    const block = match && rawValue.match(BLOCK_SCALAR_PATTERN);
    if (!match) {
      // Not a top-level key; skip the line and anything indented under it.
      if (lines[index - 1].trim() && !lines[index - 1].trim().startsWith('#')) {
        onIgnored(
          `ignored unsupported frontmatter line ${JSON.stringify(lines[index - 1].trim())}`,
        );
      }
    } else if (block) {
      const contentLines = continuation.map(line => line.trim());
      fields[key] =
        block[1] === '|'
          ? contentLines.join('\n').trim()
          : contentLines.filter(Boolean).join(' ');
    } else if (rawValue === '') {
      /** @type {Record<string, string>} */
      const nested = {};
      const indentOf = (/** @type {string} */ line) =>
        line.length - line.trimStart().length;
      const firstNested = continuation.find(line => line.trim());
      const nestedIndent = firstNested ? indentOf(firstNested) : 0;
      for (const line of continuation) {
        const trimmed = line.trim();
        const nestedMatch = trimmed.match(KEY_PATTERN);
        if (indentOf(line) > nestedIndent) {
          // Deeper nesting belongs to an entry already reported as dropped.
        } else if (
          nestedMatch &&
          nestedMatch[2] !== '' &&
          !FLOW_PATTERN.test(nestedMatch[2]) &&
          !BLOCK_SCALAR_PATTERN.test(nestedMatch[2])
        ) {
          nested[nestedMatch[1]] = unquote(nestedMatch[2]);
        } else if (trimmed && !trimmed.startsWith('#')) {
          onIgnored(
            `ignored non-string ${key} entry ${JSON.stringify(trimmed)}`,
          );
        }
      }
      fields[key] = nested;
    } else {
      // A plain scalar may continue on indented lines.
      fields[key] = [rawValue, ...continuation.map(line => line.trim())]
        .filter(Boolean)
        .map(unquote)
        .join(' ');
    }
  }
  return fields;
};
harden(parseFrontmatter);

/**
 * @param {string | Record<string, string> | undefined} value
 * @returns {string | undefined}
 */
const asString = value => (typeof value === 'string' ? value : undefined);

/**
 * Check a skill name against the agentskills.io rules.
 *
 * @param {string} name
 * @returns {string[]} the broken rules, empty when the name is valid
 */
export const validateSkillName = name => {
  const problems = [];
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    problems.push(
      'name must be lowercase a-z, 0-9, and single hyphens, neither leading nor trailing nor doubled',
    );
  }
  return problems;
};
harden(validateSkillName);

/**
 * Parse one `SKILL.md`. Following Pi, a skill without a description is not
 * loaded, since the model could never know when to use it; every other
 * violation of the specification is a warning and the skill loads anyway.
 *
 * @param {object} options
 * @param {string} options.directoryName the skill directory's own name
 * @param {string} options.text the full `SKILL.md` text
 * @param {string} options.filePath
 * @param {string} options.baseDir
 * @param {string} options.source
 * @returns {{ skill: Skill | undefined, diagnostics: SkillDiagnostic[] }}
 */
export const parseSkill = ({
  directoryName,
  text,
  filePath,
  baseDir,
  source,
}) => {
  /** @type {SkillDiagnostic[]} */
  const diagnostics = [];
  /**
   * @param {'warning' | 'error'} severity
   * @param {string} message
   */
  const report = (severity, message) =>
    diagnostics.push({ severity, source, entryName: directoryName, message });

  const { frontmatter } = splitFrontmatter(text);
  const fields =
    frontmatter === undefined
      ? {}
      : parseFrontmatter(frontmatter, message => report('warning', message));

  const description = asString(fields.description) ?? '';
  if (!description.trim()) {
    report('error', 'SKILL.md has no description, so the skill is not loaded');
    return { skill: undefined, diagnostics };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    report(
      'warning',
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  let name = asString(fields.name) ?? '';
  if (!name) {
    report('warning', 'SKILL.md has no name; using the directory name');
    name = directoryName;
  } else if (name !== directoryName) {
    report(
      'warning',
      `name ${JSON.stringify(name)} does not match directory ${JSON.stringify(directoryName)}`,
    );
  }
  for (const problem of validateSkillName(name)) {
    report('warning', problem);
  }

  const allowedTools = (asString(fields['allowed-tools']) ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const metadataField = fields.metadata;
  const metadata =
    metadataField !== undefined && typeof metadataField === 'object'
      ? { ...metadataField }
      : {};
  const license = asString(fields.license);
  const compatibility = asString(fields.compatibility);
  if (
    compatibility !== undefined &&
    compatibility.length > MAX_COMPATIBILITY_LENGTH
  ) {
    report(
      'warning',
      `compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters`,
    );
  }
  const disableField = asString(fields['disable-model-invocation']);
  if (
    disableField !== undefined &&
    disableField !== 'true' &&
    disableField !== 'false'
  ) {
    report(
      'warning',
      `disable-model-invocation ${JSON.stringify(disableField)} is not a boolean; treating it as false`,
    );
  }
  if (fields.metadata !== undefined && typeof fields.metadata !== 'object') {
    report('warning', 'metadata is not a map; ignoring it');
  }

  return {
    skill: harden({
      name,
      description,
      filePath,
      baseDir,
      source,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      allowedTools,
      disableModelInvocation: disableField === 'true',
      metadata,
    }),
    diagnostics,
  };
};
harden(parseSkill);
