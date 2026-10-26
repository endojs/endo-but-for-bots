// @ts-check
import { h } from 'preact';
import { useCallback, useState } from 'preact/hooks';

/**
 * Composer in the optional story conversation drawer.
 * @param {object} props
 * @param {(text: string) => void} props.onSend
 * @param {boolean} props.disabled
 */
export function InputBar({ onSend, disabled }) {
  const [text, setText] = useState('');
  const handleSubmit = useCallback(
    /** @param {Event} e */
    e => {
      e.preventDefault();
      if (text.trim() && !disabled) {
        onSend(text.trim());
        setText('');
      }
    },
    [text, disabled, onSend],
  );

  return h(
    'form',
    { class: 'whylip-input', onSubmit: handleSubmit },
    h('input', {
      type: 'text',
      class: 'whylip-input-field',
      placeholder: 'What if…',
      'aria-label': 'Message to the storybook',
      value: text,
      /** @param {Event} e */
      onInput: e => setText(/** @type {HTMLInputElement} */ (e.target).value),
    }),
    h(
      'button',
      {
        type: 'submit',
        class: 'whylip-send-button',
        disabled: disabled || !text.trim(),
        'aria-label': 'Send message to the book',
      },
      '↑',
    ),
  );
}
harden(InputBar);
