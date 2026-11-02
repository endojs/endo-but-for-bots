// @ts-check
import './mail-ui-lockdown.js';
import { confineComponent } from '@endo/preact-container/compartment';
import { h, renderConfined } from '@endo/preact-container/renderer';

import { makeMailEditor } from './mail-editor.js';

/** @import { MailUi } from '../../web/mail-ui.js' */
/** @import { MailUiApi, MailEditor, MailSnapshot } from '../../web/mail-ui.js' */

const token = location.hash.slice(1);
// Opening a corrected private URL may change only the fragment in this tab.
window.addEventListener('hashchange', () => location.reload());
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
  subscribe: (onState, onError) => {
    const abort = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let retry;
    let delay = 500;
    const connect = async () => {
      /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
      let reader;
      try {
        const response = await fetch('/api/events', {
          headers: { authorization: `Bearer ${token}` },
          signal: abort.signal,
          credentials: 'omit',
          redirect: 'error',
        });
        if (response.status === 403) {
          const error = Error(
            'Invalid or missing mail URL secret. Open the private URL printed by the mail-ui command.',
          );
          error.name = 'MailAccessError';
          onError(error);
          return;
        }
        if (!response.ok || !response.body)
          throw Error(
            'Mail subscription refused. Open the current private URL.',
          );
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!abort.signal.aborted) {
          // eslint-disable-next-line no-await-in-loop -- Consume stream frames in wire order.
          const { done, value } = await reader.read();
          if (done) throw Error('Mail connection lost. Reconnecting…');
          buffer += decoder.decode(value, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split('\n')
              .find(line => line.startsWith('data: '));
            if (data) {
              const state = JSON.parse(data.slice(6));
              if (frame.startsWith('event: error')) throw Error(state.error);
              delay = 500;
              onState(/** @type {MailSnapshot} */ (harden(state)));
            }
            end = buffer.indexOf('\n\n');
          }
        }
      } catch (reason) {
        if (abort.signal.aborted) return;
        onError(/** @type {Error} */ (reason));
        retry = setTimeout(() => {
          void connect();
        }, delay);
        delay = Math.min(delay * 2, 10_000);
      } finally {
        await reader?.cancel().catch(() => {});
      }
    };
    void connect();
    return harden(() => {
      abort.abort();
      clearTimeout(retry);
    });
  },
  adopt: (valueToken, name) =>
    request('/api/adopt', { token: valueToken, name }),
  send: (recipient, content) => request('/api/send', { recipient, content }),
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
      /** @type {typeof confineComponent<{api: MailUiApi, editor: MailEditor}>} */
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
      const { editor, mount } = makeMailEditor();
      const syncDialog = () => {
        mount(root);
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
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-disabled'],
      });
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
      renderConfined(h(Component, { api, editor }), root, {
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
