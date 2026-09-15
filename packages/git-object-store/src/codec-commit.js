// @ts-check

import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/** @import { GitCommitObject, GitIdentity, GitObjectId } from './types.js' */

/**
 * Parse `Name <email> unix-seconds tz`.
 *
 * @param {string} text
 * @returns {GitIdentity}
 */
export const parseIdentity = text => {
  const match = /^(.*) <([^>]+)> (-?\d+) ([+-]\d{4})$/u.exec(text);
  if (match === null) {
    throw Fail`invalid git identity ${q(text)}`;
  }
  return harden({
    name: match[1],
    email: match[2],
    when: match[3],
    tz: match[4],
  });
};
harden(parseIdentity);

/**
 * @param {GitIdentity} identity
 * @returns {string}
 */
export const formatIdentity = identity =>
  `${identity.name} <${identity.email}> ${identity.when} ${identity.tz}`;
harden(formatIdentity);

/**
 * Split commit/tag content into header lines and message body.
 * Supports folded headers (continuation lines that start with a space),
 * used by `gpgsig`.
 *
 * @param {string} text
 * @returns {{ headers: Array<[string, string]>, message: string }}
 */
const splitHeadersAndMessage = text => {
  const lines = text.split('\n');
  /** @type {Array<[string, string]>} */
  const headers = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      i += 1;
      break;
    }
    const sp = line.indexOf(' ');
    sp > 0 || Fail`invalid header line ${q(line)}`;
    const key = line.slice(0, sp);
    let value = line.slice(sp + 1);
    i += 1;
    while (i < lines.length && lines[i].startsWith(' ')) {
      value += `\n${lines[i]}`;
      i += 1;
    }
    headers.push([key, value]);
  }
  // Message is the remainder; preserve trailing newline conventions by
  // rejoining. Git commit messages typically end with a newline when the
  // source content did; `split` drops a final empty segment only when the
  // text ends with `\n`, so rejoin reconstructs the body after the blank
  // separator line.
  const message = lines.slice(i).join('\n');
  return { headers, message };
};

/**
 * @param {Uint8Array} content
 * @returns {GitCommitObject}
 */
export const parseCommit = content => {
  const text = bytesToText(content, { fatal: true });
  const { headers, message } = splitHeadersAndMessage(text);

  /** @type {GitObjectId | undefined} */
  let tree;
  /** @type {GitObjectId[]} */
  const parents = [];
  /** @type {GitIdentity | undefined} */
  let author;
  /** @type {GitIdentity | undefined} */
  let committer;
  /** @type {string | undefined} */
  let encoding;
  /** @type {string | undefined} */
  let gpgsig;

  for (const [key, value] of headers) {
    switch (key) {
      case 'tree': {
        tree === undefined || Fail`duplicate tree header`;
        tree = value;
        break;
      }
      case 'parent': {
        parents.push(value);
        break;
      }
      case 'author': {
        author === undefined || Fail`duplicate author header`;
        author = parseIdentity(value);
        break;
      }
      case 'committer': {
        committer === undefined || Fail`duplicate committer header`;
        committer = parseIdentity(value);
        break;
      }
      case 'encoding': {
        encoding = value;
        break;
      }
      case 'gpgsig': {
        gpgsig = value;
        break;
      }
      default: {
        // Real repositories may carry headers this codec does not model
        // (e.g. mergetag). Walk/read paths only need tree/parents/idents;
        // round-trip tests use synthetic objects without extras.
        break;
      }
    }
  }

  if (tree === undefined) {
    throw Fail`commit missing tree header`;
  }
  if (author === undefined) {
    throw Fail`commit missing author header`;
  }
  if (committer === undefined) {
    throw Fail`commit missing committer header`;
  }

  /** @type {GitCommitObject} */
  const commit = {
    tree,
    parents: harden(parents),
    author,
    committer,
    message,
  };
  if (encoding !== undefined) {
    commit.encoding = encoding;
  }
  if (gpgsig !== undefined) {
    commit.gpgsig = gpgsig;
  }
  return harden(commit);
};
harden(parseCommit);

/**
 * @param {GitCommitObject} commit
 * @returns {Uint8Array}
 */
export const serializeCommit = commit => {
  /** @type {string[]} */
  const lines = [];
  lines.push(`tree ${commit.tree}`);
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);
  if (commit.encoding !== undefined) {
    lines.push(`encoding ${commit.encoding}`);
  }
  if (commit.gpgsig !== undefined) {
    // gpgsig value already includes leading spaces on continuation lines.
    lines.push(`gpgsig ${commit.gpgsig}`);
  }
  // Headers and message are separated by a blank line (`\n\n`).
  const text = `${lines.join('\n')}\n\n${commit.message}`;
  return bytesFromText(text);
};
harden(serializeCommit);
