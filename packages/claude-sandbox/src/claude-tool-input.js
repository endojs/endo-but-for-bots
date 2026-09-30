// @ts-check

/**
 * Claude carries tool input as an object; transcript records carry argument
 * text. Preserve non-object JSON and unparseable text under a single key.
 *
 * @param {string} args
 */
export const claudeToolInput = args => {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return { value: args };
  }
};
harden(claudeToolInput);
