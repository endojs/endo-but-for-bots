// @ts-check
import './mail-ui-lockdown.js';
import { confineComponent } from '@endo/preact-container/compartment';
import { h, renderConfined } from '@endo/preact-container/renderer';

/** @import { MailUi } from '../../web/mail-ui.js' */
/** @import { MailUiApi } from '../../web/mail-ui.js' */

const token = location.hash.slice(1);
/** @param {string} path @param {unknown} [body] */
const request = async (path, body = undefined) => {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'omit',
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? 'Mail request failed');
  return harden(value);
};
/** @type {MailUiApi} */
const api = harden({
  snapshot: () => request('/api/mail'),
  adopt: (valueToken, name) =>
    request('/api/adopt', { token: valueToken, name }),
  send: (name, content) => request('/api/send', { name, content }),
});

const start = async () => {
  const root = document.getElementById('root');
  if (root) {
    try {
      const response = await fetch('/component.js');
      if (!response.ok) throw Error('Could not load mail component');
      const source = await response.text();
      // No document, fetch, location, storage, or administration in this realm.
      const compartment = new Compartment({ harden });
      /** @type {{MailUi: typeof MailUi}} */
      const { MailUi: guest } = compartment.evaluate(source);
      /** @type {typeof confineComponent<{api: MailUiApi}>} */
      const confineMail = confineComponent;
      const Component = confineMail(guest, {
        name: 'Mail',
        onError: () => {
          root.textContent = 'Mail could not be rendered. Reload to try again.';
        },
      });
      // DOM focus and inertness stay in the trusted shell; neither reaches
      // the compartment. The inventory remains outside this inert subtree.
      /** @type {Element | null} */
      let dialog = null;
      /** @type {Element | null} */
      let returnFocus = null;
      // Move into the text following an inserted value without exposing DOM
      // focus or selection methods to the confined component.
      let previousTextCount = 0;
      const syncDialog = () => {
        const editor = root.querySelector('.draft-editor');
        const texts = editor?.querySelectorAll('textarea');
        const count = texts?.length ?? 0;
        if (editor && count > previousTextCount) {
          const index = editor.getAttribute('data-focus-text');
          const target = editor.querySelector(
            `textarea[data-text-index="${index}"]`,
          );
          if (target instanceof HTMLTextAreaElement) {
            target.focus();
            target.setSelectionRange(0, 0);
          }
        }
        previousTextCount = count;
        const next = root.querySelector('[role="dialog"]');
        const content = root.querySelector('.mail-content');
        if (content instanceof HTMLElement) content.inert = next !== null;
        if (next && next !== dialog) {
          returnFocus = document.activeElement;
          next.querySelector('input')?.focus();
        } else if (!next && dialog) {
          if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
            returnFocus.focus();
          else root.querySelector('button')?.focus();
        }
        dialog = next;
      };
      const observer = new MutationObserver(syncDialog);
      observer.observe(root, { childList: true, subtree: true });
      root.addEventListener('keydown', event => {
        if (event.key !== 'Tab' || !dialog) return;
        const controls = dialog.querySelectorAll(
          'input:not(:disabled), button:not(:disabled)',
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        const target = event.shiftKey
          ? document.activeElement === first
            ? last
            : undefined
          : document.activeElement === last
            ? first
            : undefined;
        if (target instanceof HTMLElement) {
          event.preventDefault();
          target.focus();
        }
      });
      root.replaceChildren();
      renderConfined(h(Component, { api }), root, {
        allowedTags: [
          'main',
          'header',
          'div',
          'p',
          'h1',
          'h2',
          'span',
          'button',
          'nav',
          'section',
          'form',
          'label',
          'select',
          'option',
          'textarea',
          'strong',
          'small',
          'article',
          'aside',
          'input',
        ],
      });
    } catch (_error) {
      root.textContent =
        'Mail could not be loaded. Open the URL printed by the mail-ui command.';
    }
  }
};
void start();
