// @ts-check

/** @import { PromptTemplate } from './types.js' */

import harden from '@endo/harden';

import { extractVariables } from './substitute.js';

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n?---(?:\n|$)/;
const DESCRIPTION_PATTERN = /^description:[ \t]*(.*?)[ \t]*$/m;
const QUOTED_PATTERN = /^(["'])(.*)\1$/;
const BLOCK_SCALAR_PATTERN = /^[|>]/;
const DESCRIPTION_FALLBACK_LENGTH = 60;

/**
 * Read `description` from frontmatter. Templates use no other frontmatter key,
 * so this reads that one line rather than taking on a YAML parser; a block
 * scalar reads as absent, and the caller falls back to the body.
 *
 * @param {string} frontmatter
 * @returns {string}
 */
const readDescription = frontmatter => {
  const match = frontmatter.match(DESCRIPTION_PATTERN);
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
  return harden({
    name,
    description:
      (frontmatterMatch && readDescription(frontmatterMatch[1])) ||
      firstLineDescription(body),
    body,
    variables: extractVariables(body),
    source,
  });
};
harden(parsePromptTemplate);
