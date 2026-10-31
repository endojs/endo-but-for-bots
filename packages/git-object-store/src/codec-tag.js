// @ts-check

import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

import { formatIdentity, parseIdentity } from './codec-commit.js';
import { assertObjectType } from './frame.js';

/** @import { GitObjectId, GitObjectType, GitTagObject } from './types.js' */

/**
 * Split tag content into headers and message (same folding rules as commit).
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
  const message = lines.slice(i).join('\n');
  return { headers, message };
};

/**
 * @param {Uint8Array} content
 * @returns {GitTagObject}
 */
export const parseTag = content => {
  const text = bytesToText(content, { fatal: true });
  const { headers, message } = splitHeadersAndMessage(text);

  /** @type {GitObjectId | undefined} */
  let object;
  /** @type {GitObjectType | undefined} */
  let type;
  /** @type {string | undefined} */
  let tag;
  /** @type {ReturnType<typeof parseIdentity> | undefined} */
  let tagger;

  for (const [key, value] of headers) {
    switch (key) {
      case 'object': {
        object === undefined || Fail`duplicate object header`;
        object = value;
        break;
      }
      case 'type': {
        type === undefined || Fail`duplicate type header`;
        assertObjectType(value);
        type = value;
        break;
      }
      case 'tag': {
        tag === undefined || Fail`duplicate tag header`;
        tag = value;
        break;
      }
      case 'tagger': {
        tagger === undefined || Fail`duplicate tagger header`;
        tagger = parseIdentity(value);
        break;
      }
      default: {
        // Ignore unmodeled headers; walk paths do not need them.
        break;
      }
    }
  }

  if (object === undefined) {
    throw Fail`tag missing object header`;
  }
  if (type === undefined) {
    throw Fail`tag missing type header`;
  }
  if (tag === undefined) {
    throw Fail`tag missing tag header`;
  }
  if (tagger === undefined) {
    throw Fail`tag missing tagger header`;
  }

  return harden({
    object,
    type,
    tag,
    tagger,
    message,
  });
};
harden(parseTag);

/**
 * @param {GitTagObject} tagObject
 * @returns {Uint8Array}
 */
export const serializeTag = tagObject => {
  assertObjectType(tagObject.type);
  const lines = [
    `object ${tagObject.object}`,
    `type ${tagObject.type}`,
    `tag ${tagObject.tag}`,
    `tagger ${formatIdentity(tagObject.tagger)}`,
  ];
  // Headers and message are separated by a blank line (`\n\n`).
  const text = `${lines.join('\n')}\n\n${tagObject.message}`;
  return bytesFromText(text);
};
harden(serializeTag);
