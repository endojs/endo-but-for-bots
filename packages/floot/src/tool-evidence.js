// @ts-check

/**
 * Deciding whether two records describe the same tool call.
 *
 * A turn's tool calls are recorded twice: mirrored into the conversation tree
 * as the provider sent them, and journaled as durable evidence that Endo ran
 * them. `getHistory` shows the journal's record only where the tree has none,
 * so it has to tell when the two are the same call. They rarely match byte for
 * byte:
 *
 * - the tree keeps the provider's argument string (`{"code": "…"}`), while the
 *   journal re-serializes the parsed arguments (`{"code":"…"}`);
 * - the journal cuts a long field to a preview and keeps the rest behind a
 *   `<field>Ref`, so its text is a prefix of the full one.
 *
 * Comparing strings made every such call appear twice in the transcript.
 */

/**
 * The arguments as JSON would write them, when they are complete JSON.
 *
 * @param {unknown} text
 * @returns {string | undefined}
 */
const normalizedJson = text => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * The text with JSON's own spacing taken out: whitespace outside string
 * literals. Whitespace inside one is content and stays. Works on a preview
 * too, which may end in the middle of a string.
 *
 * @param {string} text
 */
const withoutJsonSpacing = text => {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === '\\') {
        index += 1;
        if (index < text.length) out += text[index];
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  return out;
};

/**
 * @typedef {object} ToolText
 * @property {unknown} text
 * @property {boolean} [cut] - `text` is a preview: a prefix of the whole.
 */

/**
 * Whether two argument strings are the same arguments.
 *
 * @param {ToolText} left
 * @param {ToolText} right
 * @returns {boolean}
 */
export const sameToolArgs = (left, right) => {
  if (left.text === right.text) return true;
  if (typeof left.text !== 'string' || typeof right.text !== 'string') {
    return false;
  }
  // Two whole argument strings are compared as JSON, which settles spacing
  // and escapes and nothing else: whitespace inside a value is content.
  if (!left.cut && !right.cut) {
    const a = normalizedJson(left.text);
    const b = normalizedJson(right.text);
    if (a !== undefined && b !== undefined) return a === b;
    // Arguments that did not parse (a model's truncated JSON, or none at all)
    // were run as `{}`, and that is what the journal recorded.
    return (a === undefined && b === '{}') || (b === undefined && a === '{}');
  }
  // A preview cannot be parsed. It is a prefix of the arguments as JSON writes
  // them (the journal's own) or as they arrived (activity a backend
  // reported), so both sides are reduced to the same spacing and compared as
  // far as the shorter goes. A whole must be at least as long as a preview.
  const form = ({ text, cut }) =>
    withoutJsonSpacing((cut ? undefined : normalizedJson(text)) ?? text);
  const a = form(/** @type {{ text: string, cut?: boolean }} */ (left));
  const b = form(/** @type {{ text: string, cut?: boolean }} */ (right));
  const shared = Math.min(a.length, b.length);
  return (
    shared > 0 &&
    a.slice(0, shared) === b.slice(0, shared) &&
    (left.cut || a.length >= b.length) &&
    (right.cut || b.length >= a.length)
  );
};
harden(sameToolArgs);

/**
 * Whether two result strings are the same result. Results have one source and
 * are never re-serialized, so only the preview cut can separate them.
 *
 * @param {ToolText} left
 * @param {ToolText} right
 * @returns {boolean}
 */
export const sameToolResult = (left, right) => {
  if (left.text === right.text) return true;
  if (typeof left.text !== 'string' || typeof right.text !== 'string') {
    return false;
  }
  if (!left.cut && !right.cut) return false;
  const shared = Math.min(left.text.length, right.text.length);
  return (
    shared > 0 &&
    left.text.slice(0, shared) === right.text.slice(0, shared) &&
    // A preview is a prefix of the whole, never the reverse: the side that
    // is whole must be at least as long as the one that was cut.
    (left.cut || left.text.length >= right.text.length) &&
    (right.cut || right.text.length >= left.text.length)
  );
};
harden(sameToolResult);
