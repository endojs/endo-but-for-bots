// @ts-check

/**
 * Copy historical dialogue as data, not capabilities or tool dispatches.
 * Never truncate: existing native context may continue, but an adapter needing
 * a new native thread must fail visibly if the complete copy is unavailable.
 * @param {Array<Record<string, any>>} history
 */
export const makeHostedContinuityOptions = history => {
  if (history.length === 0) return harden({ continuityContext: '' });
  const parts = [];
  // This is a deliberately bounded 256-Ki-character profile, not a counter
  // for an unbounded transcript.
  let length = 2;
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
    const part = JSON.stringify(record);
    length += part.length + (parts.length ? 1 : 0);
    if (length > 256 * 1024)
      return harden({
        continuityContextUnavailable: 'history exceeds replay limit',
      });
    parts.push(part);
  }
  return harden({ continuityContext: `[${parts.join(',')}]` });
};
harden(makeHostedContinuityOptions);
