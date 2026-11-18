// @ts-check
/**
 * The composer (R6-40, R6-43, R6-49; m3-interfaces.md 9.2, 9.3; W3.6).
 *
 * - The text and caret are the controller's (`view.input`): typing calls
 *   `setInput(text, caret)`; a `composer.addon` feature gets
 *   `{ context, input, replaceRange }` (`ComposerAddonProps`) and edits the
 *   input with `replaceRange(start, end, text)`, after which the caret is
 *   placed after the insert.
 * - Enter sends, Shift+Enter is a new line, and a key that belongs to an
 *   IME composition (`isComposing`, key code 229) never sends.
 * - Sending is `controller.send(text)`: the saved draft and request id,
 *   the Web Lock and the addon chain are the controller's (9.2). A
 *   rejection leaves the text and shows `view.sendError` until the next
 *   edit or send. Sending while a turn runs queues the message.
 * - Blocked sending (R6-43, A-5; no Web Locks): the text box and Send are
 *   disabled and the reason (`view.blocked`) is shown.
 * - ■ Stop cancels the running turn (R6-49); leaving the page cancels
 *   nothing.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { ConversationSlot } from './slots.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * Whether a key event belongs to an IME composition.
 *
 * @param {any} event
 */
export const isComposing = event =>
  Boolean(event.isComposing) || event.keyCode === 229;

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 * }} props
 */
export const Composer = ({ state, controller, features, context }) => {
  const ref = useRef(/** @type {any} */ (null));
  const [sending, setSending] = useState(false);
  const view = state.view;
  const input = view ? view.input : { text: '', caret: 0 };

  // Keep the box's caret where the controller says (after an addon's
  // replaceRange); typing reports the same caret, so this is then a no-op.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.value !== input.text) element.value = input.text;
    if (
      element.selectionStart !== input.caret ||
      element.selectionEnd !== input.caret
    ) {
      try {
        element.setSelectionRange(input.caret, input.caret);
      } catch {
        // an element that cannot take a selection: nothing to place
      }
    }
  }, [input.text, input.caret]);

  if (!view) return null;
  const blocked = view.blocked;

  const send = () => {
    const current = controller.getState().view;
    if (!current || current.blocked || sending) return;
    const text = current.input.text;
    if (text.trim() === '') return;
    setSending(true);
    // `send` reports its own failure (`view.sendError`) and never rejects.
    Promise.resolve(controller.send(text)).finally(() => setSending(false));
  };

  return h(
    'div',
    { class: 'thix-composer' },
    h(ConversationSlot, {
      slot: 'composer.addon',
      features,
      context,
      class: 'thix-composer-addons',
      props: {
        input: view.input,
        replaceRange: (
          /** @type {number} */ start,
          /** @type {number} */ end,
          /** @type {string} */ text,
        ) => controller.replaceInput(start, end, text),
      },
    }),
    blocked
      ? h('div', { class: 'thix-composer-blocked', role: 'status' }, blocked)
      : null,
    view.sendError
      ? h('div', { class: 'thix-send-error', role: 'alert' }, view.sendError)
      : null,
    h(
      'div',
      { class: 'floot-compose' },
      h('textarea', {
        ref,
        class: 'floot-input',
        rows: 1,
        placeholder: uiTexts.composerPlaceholder,
        'aria-label': uiTexts.composerPlaceholder,
        disabled: Boolean(blocked),
        value: view.input.text,
        /** @param {any} event */
        onInput: event =>
          controller.setInput(
            event.target.value,
            typeof event.target.selectionStart === 'number'
              ? event.target.selectionStart
              : event.target.value.length,
          ),
        /** @param {any} event */
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey && !isComposing(event)) {
            event.preventDefault();
            send();
          }
        },
      }),
      view.busy
        ? h(
            'button',
            {
              type: 'button',
              class: 'floot-send cancel thix-stop',
              'aria-label': uiTexts.stop,
              onClick: () => controller.stop(),
            },
            uiTexts.stop,
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'floot-send thix-send',
          'aria-label': uiTexts.send,
          disabled: Boolean(blocked) || sending,
          onClick: send,
        },
        '↑',
      ),
    ),
  );
};
