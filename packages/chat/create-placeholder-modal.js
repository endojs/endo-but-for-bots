// @ts-check

import harden from '@endo/harden';

import {
  Fragment,
  h,
  renderConfined,
  unmount,
} from './setup-preact-container.js';

// Documented placeholders for the item types the design scopes OUT of this
// phase's working set (passable value, structured value). Per the job and the
// design, these surface the architectural direction without offering a
// half-implemented control: the modal explains what the item type is, how it
// will be created, and which daemon primitive backs it — but does not expose a
// half-working form. This keeps the `+` menu complete (every item type is
// reachable) while honoring the phasing.

/**
 * @typedef {object} PlaceholderSpec
 * @property {string} title
 * @property {string} summary
 * @property {string[]} points - Direction bullets (what it will do).
 * @property {string} backing - The daemon primitive it will compose.
 */

/** @type {Record<string, PlaceholderSpec>} */
export const PLACEHOLDERS = harden({
  passable: {
    title: 'Passable value',
    summary:
      'A primitive, list, or record stored as a value formula under a pet name.',
    points: [
      'Enter a value as SmallCaps text (reusing the eval form’s Monaco editor).',
      'Remotable references are not accepted from this surface — they need a source capability.',
      'On submit the text is parsed with @endo/marshal and stored via storeValue.',
    ],
    backing: 'Composes the existing storeValue + @endo/marshal primitives.',
  },
  structured: {
    title: 'Structured value',
    summary:
      'A passable value that conforms to an @endo/patterns pattern, entered field-by-field.',
    points: [
      'Enter a pattern first (SmallCaps), then a per-field form is derived from its split.',
      'Each leaf pattern picks the input widget (string→text, number→numeric, boolean→checkbox, or→select).',
      'The value and its pattern are stored together via the existing form machinery.',
    ],
    backing: 'Composes the daemon-form-request FormField pattern machinery.',
  },
});

/**
 * Host factory for the placeholder modal.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.$container
 * @returns {{ show: (kind: string) => void, hide: () => void }}
 */
export const createPlaceholderModal = ({ $container }) => {
  const hide = () => {
    unmount($container);
    $container.innerHTML = '';
  };

  /** @param {string} kind */
  const show = kind => {
    const spec = PLACEHOLDERS[kind];
    if (!spec) return;
    renderConfined(
      h(
        Fragment,
        null,
        h('div', { class: 'create-modal-backdrop', onClick: hide }),
        h(
          'div',
          {
            class: 'create-modal',
            role: 'dialog',
            'aria-label': spec.title,
            onKeyDown: (/** @type {{ key: string }} */ e) => {
              if (e.key === 'Escape') hide();
            },
          },
          h(
            'div',
            { class: 'create-modal-header' },
            h('span', { class: 'create-modal-title' }, spec.title),
            h(
              'button',
              {
                type: 'button',
                class: 'create-modal-close',
                title: 'Close (Esc)',
                onClick: hide,
              },
              '×',
            ),
          ),
          h(
            'div',
            { class: 'create-modal-placeholder' },
            h('span', { class: 'create-modal-badge' }, 'Coming soon'),
            h('p', { class: 'create-modal-desc' }, spec.summary),
            h(
              'ul',
              { class: 'create-modal-points' },
              spec.points.map((p, i) => h('li', { key: i }, p)),
            ),
            h('p', { class: 'create-modal-backing' }, spec.backing),
          ),
          h(
            'div',
            { class: 'create-modal-actions' },
            h(
              'button',
              { type: 'button', class: 'create-modal-submit', onClick: hide },
              'Got it',
            ),
          ),
        ),
      ),
      $container,
    );
  };

  return harden({ show, hide });
};
harden(createPlaceholderModal);
