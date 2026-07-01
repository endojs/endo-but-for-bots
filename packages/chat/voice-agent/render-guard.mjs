// @ts-check
// render-guard.mjs — one shared place to DETECT and PREVENT the "[object Object]" render smell.
//
// The bug class (recurring): an agent authors a confined renderer / live widget and passes a JS
// OBJECT (or promise, map, …) into a TEXT slot — h(Card,{body: someObject}), a Chip/Badge/Btn
// `label`, a TextField `value`, a followed live-cell value. The confined kit coerces text with
// String(), so Object.prototype.toString runs and the human sees the literal "[object Object]"
// (or "[object Promise]", "[object Map]", …) on screen instead of their data.
//
// This module is the single source of truth for THREE tiers (client mirrors safeText/scan inline
// because confined.html is a static, import-free sandbox — keep the two in lockstep):
//   • client (public/confined.html) — safeText() renders a READABLE fallback instead of the smell,
//     and reports the smell up to the host over the existing MessagePort;
//   • server (POST /render-smell) — scanText() confirms it and files it to the owner feedback-loops
//     view;
//   • authoring loop (blossom / authorRenderer) — smellFeedback() phrases the correction that is fed
//     back so the renderer auto-corrects on its next authoring pass.

if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

// The fingerprint of a value dropped into a text slot un-rendered: a default Object.prototype
// .toString() tag, "[object Xxx]". Match ANY tag (Object, Promise, Map, Set, Error, Arguments,
// Function, …) so a leaked promise or map is caught as readily as a plain object.
const SMELL_SOURCE = '\\[object [A-Za-z][\\w$]*\\]';

/** @param {unknown} v */
const str = v => {
  try {
    return String(v);
  } catch {
    return '';
  }
};

/**
 * Every coercion-smell fingerprint found in an already-produced string of text/HTML.
 * @param {unknown} text
 * @returns {string[]} e.g. ['[object Object]', '[object Promise]']
 */
export const scanText = text => {
  const re = new RegExp(SMELL_SOURCE, 'g');
  const out = [];
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(str(text)))) out.push(m[0]);
  return out;
};
harden(scanText);

/**
 * Would coercing `val` to text with String() produce a smell? (i.e. is it an object/promise/etc.
 * that would render as "[object Xxx]"?)
 * @param {unknown} val
 */
export const coercesToSmell = val => new RegExp(SMELL_SOURCE).test(str(val));
harden(coercesToSmell);

/**
 * Coerce `val` for a TEXT slot WITHOUT ever emitting a coercion smell. Objects become readable
 * (compact JSON, truncated); functions/symbols/promises become a small marker; primitives pass
 * through. This is what a text sink should call instead of String(val).
 * @param {unknown} val
 * @param {{max?: number}} [opts]
 * @returns {string}
 */
export const safeText = (val, { max = 400 } = {}) => {
  if (val == null) return '';
  const t = typeof val;
  if (t === 'string') return val;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val);
  if (t === 'symbol') return val.toString();
  if (t === 'function') return ''; // a function in a text slot is a mistake — render nothing, not its source
  // object-ish: render the DATA, never "[object …]".
  if (typeof (/** @type {any} */ (val).then) === 'function') return '⟨pending…⟩'; // a leaked promise
  let out;
  try {
    out = JSON.stringify(val);
  } catch {
    out = ''; // circular / non-serializable
  }
  if (!out || out === '{}' || out === '[]') {
    // Nothing legible from JSON — fall back to the constructor name so it's still not a raw smell.
    const name = (/** @type {any} */ (val).constructor && /** @type {any} */ (val).constructor.name) || 'object';
    out = `⟨${name}⟩`;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};
harden(safeText);

/**
 * The combined sink helper: return safe text to render AND a smell descriptor (or null) to report.
 * `where` labels the render site (e.g. 'Card.body', a cell id) for actionable feedback.
 * @param {unknown} val
 * @param {{where?: string, max?: number}} [opts]
 * @returns {{ text: string, smell: null | { tag: string, where: string, preview: string } }}
 */
export const inspectForText = (val, { where = '', max = 400 } = {}) => {
  const text = safeText(val, { max });
  if (!coercesToSmell(val)) return { text, smell: null };
  const tag = str(val).match(new RegExp(SMELL_SOURCE)) || ['[object Object]'];
  return { text, smell: { tag: tag[0], where, preview: text.slice(0, 120) } };
};
harden(inspectForText);

/**
 * Phrase the correction fed back to the authoring agent when a render smell is detected.
 * @param {Array<string | { tag?: string }>} smells
 * @param {{where?: string}} [opts]
 * @returns {string}
 */
export const smellFeedback = (smells, { where = '' } = {}) => {
  const tags = [
    ...new Set((smells || []).map(s => (typeof s === 'string' ? s : s && s.tag)).filter(Boolean)),
  ];
  const what = tags.length ? tags.join(', ') : '[object Object]';
  const at = where ? ` at ${where}` : '';
  return (
    `Your widget rendered a raw JavaScript value as text (${what})${at}. ` +
    `A value you passed into a TEXT slot is an object/promise, not a string, so the kit coerced it to "${what}". ` +
    `Fix it: render a specific field (e.g. value.name), JSON.stringify the object, await the promise, ` +
    `or pass it as CHILDREN instead of a text prop. Text props — Card.title/body/footer, ` +
    `Chip/Badge/Btn/Avatar label, EmptyState/Banner text, TextField.value, and any followed live-cell value — ` +
    `must resolve to a string or number.`
  );
};
harden(smellFeedback);
