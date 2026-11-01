// @ts-check

/**
 * Strip fenced code before sentence chunking, including fences split across
 * text deltas. Plain prose passes through immediately; only a possible fence
 * prefix at the start of a line is delayed. Code is discarded incrementally.
 */
export const makeSpeechCodeFilter = () => {
  let start = true;
  let prefix = '';
  let fence = '';
  let lineTooLong = false;
  let openingRun = false;
  /** @param {string} text */
  const push = text => {
    let out = '';
    for (const char of text) {
      if (fence) {
        if (openingRun && char === fence[0]) {
          fence += char;
          // eslint-disable-next-line no-continue
          continue;
        }
        openingRun = false;
        if (char === '\n') {
          if (
            !lineTooLong &&
            prefix.trim().length >= fence.length &&
            [...prefix.trim()].every(c => c === fence[0])
          ) {
            fence = '';
            out += '\n';
          }
          prefix = '';
          lineTooLong = false;
        } else if (prefix.length < 128) {
          prefix += char;
        } else {
          lineTooLong = true;
        }
      } else if (start) {
        prefix += char;
        const run = /^(`{3,}|~{3,})/.exec(prefix);
        if (run) {
          // Language/source after an opening fence is never speech. Starting
          // suppression at the third marker keeps arbitrarily long code cheap.
          fence = run[1];
          openingRun = true;
          prefix = '';
          lineTooLong = true; // the rest of this opening line is not a close
        } else if (!/^`{1,2}$|^~{1,2}$/.test(prefix)) {
          out += prefix;
          start = char === '\n';
          prefix = '';
        }
      } else {
        out += char;
        if (char === '\n') start = true;
      }
    }
    return out;
  };
  return harden({
    push,
    finish() {
      const tail = fence ? '' : prefix;
      prefix = '';
      return tail;
    },
  });
};
harden(makeSpeechCodeFilter);
