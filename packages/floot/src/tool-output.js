// @ts-check
import { decodeImageResult } from '@endo/hosted-agent/image-result.js';

/** Includes the truncation marker; measured in JavaScript UTF-16 code units. */
export const MAX_TOOL_OUTPUT_CHARS = 32_768;
harden(MAX_TOOL_OUTPUT_CHARS);

/**
 * Bound both the model input and its durable tool-result record. Truncation
 * never implies failure or permission to re-execute an effectful tool.
 * @param {string} text
 * @param {number} [limit]
 */
export const boundToolOutput = (text, limit = MAX_TOOL_OUTPUT_CHARS) => {
  // Images have a separate binary bound; cutting base64 corrupts model input.
  if (decodeImageResult(text)) return text;
  if (text.length <= limit) return text;
  const marker = `\n[Tool output truncated from ${text.length} characters. Only a prefix is shown; use filtering or pagination for more.]`;
  let end = limit - marker.length;
  // Do not split a UTF-16 surrogate pair at the boundary.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
};
harden(boundToolOutput);
