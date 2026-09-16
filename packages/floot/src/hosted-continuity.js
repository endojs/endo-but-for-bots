// @ts-check

/**
 * Copy historical dialogue as data, not capabilities or tool dispatches.
 * Never truncate: existing native context may continue, but an adapter needing
 * a new native thread must fail visibly if the complete copy is unavailable.
 *
 * There is no length ceiling. The one that used to be here turned a long
 * conversation into `continuityContextUnavailable` — a conversation refused
 * for being long, which is the opposite of what continuity is for, and a
 * number this stack chose rather than one any model or protocol imposes. The
 * refusals that remain are about what the dialogue *is*, not how much of it
 * there is.
 *
 * @param {Array<Record<string, any>>} history
 */
export const makeHostedContinuityOptions = history => {
  if (history.length === 0) return harden({ continuityContext: '' });
  const parts = [];
  for (const message of history) {
    if (!['user', 'assistant', 'tool'].includes(message.role)) {
      return harden({
        continuityContextUnavailable: 'history contains an unsupported role',
      });
    }
    const fields =
      message.role === 'tool' ? ['name', 'args', 'result'] : ['content'];
    /** @type {Record<string, string | boolean | null>} */
    const record = { role: message.role };
    for (const field of fields) {
      const value = message[field];
      if (typeof value !== 'string' && value !== null) {
        return harden({
          continuityContextUnavailable: 'history contains non-text dialogue',
        });
      }
      record[field] = value;
    }
    // Recovery status/notes are textual evidence. Other UI metadata is not
    // dialogue and can contain mail references or capabilities: omit it.
    for (const field of ['turnState', 'resolution', 'turnStatus']) {
      const value = message.meta?.[field];
      if (typeof value === 'string' || typeof value === 'boolean')
        record[field] = value;
    }
    parts.push(JSON.stringify(record));
  }
  return harden({ continuityContext: `[${parts.join(',')}]` });
};
harden(makeHostedContinuityOptions);
