// @ts-check

/**
 * Append an adoption hint to a tool error that mentions an "Unknown pet name".
 * The model often produces this error on the first turn after receiving a
 * message with attached @-references it has not yet adopted; the hint
 * recovers from that case without needing a retry.
 *
 * @param {string} errorMessage
 * @returns {string}
 */
export const addAdoptionHintToError = errorMessage => {
  const match = errorMessage.match(/Unknown pet name: "([^"]+)"/);
  if (!match) return errorMessage;
  const missing = match[1];
  return `${errorMessage}\nHint: "${missing}" is not in your pet name directory. If it appeared as an @-reference in an inbox message, you must adopt it first: adopt(messageNumber, "${missing}", "${missing}") for plain values, or adoptTool(messageNumber, "${missing}", "${missing}") for tool capabilities.`;
};
harden(addAdoptionHintToError);
