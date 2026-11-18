// @ts-check
/**
 * The `</>` raw view (R6-45; W3.6): each turn's entry as pretty JSON,
 * exactly as the controller holds it (records and events as received), and
 * the queue's rows. Presences print as their alleged name (`[Alleged:
 * Blob]`); a value the serializer cannot take shows its failure in its
 * block, not a blank transcript. Floot's `RawBlock` look at `1315bef86`.
 */
import { h } from 'preact';

/**
 * A JSON replacer: bigints spelled out, presences (objects with a
 * `Symbol.toStringTag` and no own keys) by their tag.
 *
 * @param {string} _key
 * @param {unknown} value
 */
const replacer = (_key, value) => {
  if (typeof value === 'bigint') return `${value}n`;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    const tag = /** @type {any} */ (value)[Symbol.toStringTag];
    if (typeof tag === 'string') return `[${tag}]`;
  }
  return value;
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export const rawJson = value => {
  try {
    return JSON.stringify(value, replacer, 2) ?? String(value);
  } catch (error) {
    return `<unserializable: ${/** @type {Error} */ (error).message}>`;
  }
};

/**
 * @param {{ label: string, value: unknown }} props
 */
const RawBlock = ({ label, value }) =>
  h(
    'div',
    { class: 'floot-msg-row assistant' },
    h(
      'div',
      { class: 'floot-tool thix-raw' },
      h('div', { class: 'floot-tool-label' }, label),
      h('pre', { class: 'floot-tool-pre' }, rawJson(value)),
    ),
  );

/**
 * @param {{ view: Record<string, any> }} props
 */
export const RawView = ({ view }) =>
  h(
    'div',
    { class: 'thix-raw-view' },
    view.messages.map((/** @type {Record<string, any>} */ entry) =>
      h(RawBlock, {
        key: entry.turnId,
        label: `turn ${entry.turnId} (raw)`,
        value: entry,
      }),
    ),
    view.pending.length !== 0
      ? h(RawBlock, {
          key: 'pending',
          label: 'pending (raw)',
          value: view.pending,
        })
      : null,
  );
