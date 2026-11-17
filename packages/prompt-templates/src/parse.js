// @ts-check

/** @import { PromptTemplate } from './types.js' */

import harden from '@endo/harden';

import { analyzePlaceholders, parseArgumentHint } from './substitute.js';

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n?---(?:\n|$)/;
const QUOTED_PATTERN = /^(["'])(.*)\1$/;
const BLOCK_SCALAR_PATTERN = /^[|>]/;
const DESCRIPTION_FALLBACK_LENGTH = 60;

/**
 * Read one single-line key from frontmatter. Templates use only
 * `description` and `argument-hint` and ignore every other key, so this reads
 * lines rather than taking on a YAML parser; a block scalar reads as absent.
 *
 * @param {string} frontmatter
 * @param {string} key
 * @returns {string}
 */
const readFrontmatterValue = (frontmatter, key) => {
  const match = frontmatter.match(
    new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm'),
  );
  if (!match || BLOCK_SCALAR_PATTERN.test(match[1])) {
    return '';
  }
  const quoted = match[1].match(QUOTED_PATTERN);
  return quoted ? quoted[2] : match[1];
};

/**
 * @param {string} body
 * @returns {string}
 */
const firstLineDescription = body => {
  const line = body.split('\n').find(candidate => candidate.trim()) ?? '';
  return line.length > DESCRIPTION_FALLBACK_LENGTH
    ? `${line.slice(0, DESCRIPTION_FALLBACK_LENGTH)}...`
    : line;
};

/**
 * Parse one template file. Frontmatter is optional; a file whose opening `---`
 * is never closed is all body.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.text
 * @param {string} options.source
 * @returns {PromptTemplate}
 */
export const parsePromptTemplate = ({ name, text, source }) => {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(FRONTMATTER_PATTERN);
  const content = frontmatterMatch
    ? normalized.slice(frontmatterMatch[0].length)
    : normalized;
  const body = content.replace(/^\n+/, '').trimEnd();
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
  const { maxPosition, usesRest } = analyzePlaceholders(body);
  return harden({
    name,
    description:
      readFrontmatterValue(frontmatter, 'description') ||
      firstLineDescription(body),
    body,
    argumentHint: parseArgumentHint(
      readFrontmatterValue(frontmatter, 'argument-hint'),
    ),
    maxPosition,
    usesRest,
    source,
  });
};
harden(parsePromptTemplate);
