// @ts-check

import { classifyStreamEvent } from './shapes.js';

/**
 * Reduce newline-delimited stream-json into the facts a turn needs. The
 * reducer is fed raw chunks and never throws on malformed lines.
 *
 * @param {object} options
 * @param {string} [options.version]  pinned CLI version, for the shape table
 */
export const makeStreamReducer = ({ version } = {}) => {
  let buffer = '';
  /** @type {any} */
  let init;
  /** @type {any} */
  let result;
  /** @type {import('@endo/inference/src/types.js').InferResult | undefined} */
  let classified;
  let events = 0;
  let malformed = 0;

  /** @param {string} line */
  const onLine = line => {
    if (line.trim() === '') return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      return;
    }
    events += 1;
    if (event.type === 'system' && event.subtype === 'init') init = event;
    if (event.type === 'result') result = event;
    if (classified === undefined) {
      classified = classifyStreamEvent(version ?? init?.claude_code_version, event);
    }
  };

  return harden({
    /** @param {string} chunk */
    push: chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(onLine);
    },
    end: () => {
      onLine(buffer);
      buffer = '';
    },
    snapshot: () =>
      harden({ init, result, classified, events, malformed }),
  });
};
harden(makeStreamReducer);
