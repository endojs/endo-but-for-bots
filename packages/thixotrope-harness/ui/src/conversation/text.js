// @ts-check
/**
 * Plain text and links (R6-46), and large content (m3-interfaces.md 9.2,
 * "Large content"; W3.6).
 *
 * `linkify` is Floot's (`space-floot/src/MessageList.js` at `1315bef86`):
 * only http(s) URLs become links, opened in a new tab without an opener;
 * everything else stays a text node, so a reply is never markup.
 *
 * A text field may arrive staged (`StagedText` `{ blob, preview, bytes }`,
 * or an archived `SealedField` `{ sealed, preview, bytes }`): `LongText`
 * shows its preview and, on "Show all", reads the whole text through
 * `controller.readContent` (`Content.read` / `SealedText.read` in
 * `blobPageBytes` pages).
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTextOf } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { labels } from './labels.js';
import { messageOf } from './slots.js';

/** @import { VNode } from 'preact' */

const URL_RE = /(https?:\/\/[^\s]+)/g;

const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  "'",
  '"',
]);

/**
 * Split a matched URL from the sentence punctuation after it; a closing
 * paren stays while the URL has one open.
 *
 * @param {string} url
 * @returns {[string, string]}
 */
const splitTrailingPunctuation = url => {
  let opened = 0;
  let closed = 0;
  for (const char of url) {
    if (char === '(') opened += 1;
    if (char === ')') closed += 1;
  }
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url[end - 1])) {
    if (url[end - 1] === ')') {
      if (closed <= opened) break;
      closed -= 1;
    }
    end -= 1;
  }
  return [url.slice(0, end), url.slice(end)];
};

/**
 * Text as Preact children: each http(s) URL an `<a target="_blank"
 * rel="noopener noreferrer">`, the rest text nodes.
 *
 * @param {string | undefined | null} text
 * @returns {Array<string | VNode>}
 */
export const linkify = text => {
  const source = `${text || ''}`;
  if (!source) return [source];
  /** @type {Array<string | VNode>} */
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(URL_RE)) {
    const start = /** @type {number} */ (match.index);
    const [url, trailing] = splitTrailingPunctuation(match[0]);
    if (start > last) parts.push(source.slice(last, start));
    if (url) {
      parts.push(
        h(
          'a',
          {
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'floot-link',
          },
          url,
        ),
      );
    }
    if (trailing) parts.push(trailing);
    last = start + match[0].length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts.length ? parts : [source];
};

/**
 * A staged field (`StagedText` or `SealedField`)?
 *
 * @param {unknown} value
 * @returns {value is { preview: string, bytes: number, blob?: any, sealed?: any }}
 */
export const isStagedText = value =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (/** @type {any} */ (value).preview) === 'string' &&
  typeof (/** @type {any} */ (value).bytes) === 'number';

/**
 * The text a field shows without reading: itself, or a staged field's
 * preview.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const shownText = value => {
  if (typeof value === 'string') return value;
  if (isStagedText(value)) return value.preview;
  return value === undefined || value === null ? '' : String(value);
};

/**
 * A text field: inline text as is; a staged one as its preview with "Show
 * all", which reads the whole text in pages.
 *
 * @param {{ value: unknown, controller: any }} props
 */
export const LongText = ({ value, controller }) => {
  const [full, setFull] = useState(/** @type {string | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  // Children as an array, not a top-level Fragment: under the unit lane's
  // Preact taming a component's top-level Fragment loses its element
  // children (W3.6 finding); an array renders the same everywhere.
  if (!isStagedText(value)) return linkify(shownText(value));
  if (full !== null) return linkify(full);
  const expand = () => {
    setLoading(true);
    setError(null);
    Promise.resolve()
      .then(() => controller.readContent(value))
      .then(
        text => setFull(text),
        reason => setError(uiTextOf.statusError(messageOf(reason))),
      )
      .finally(() => setLoading(false));
  };
  return [
    ...linkify(value.preview),
    h(
      'button',
      {
        type: 'button',
        class: 'thix-show-all',
        disabled: loading,
        onClick: expand,
      },
      loading ? labels.loadingText : labels.showAll(value.bytes),
    ),
    error
      ? h('span', { class: 'thix-text-error', role: 'alert' }, error)
      : null,
  ];
};
