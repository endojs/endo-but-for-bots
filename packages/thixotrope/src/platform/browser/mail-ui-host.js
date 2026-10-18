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
  send: (name, text, attachment) =>
    request('/api/send', { name, text, attachment }),
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
        ],
      });
    } catch (_error) {
      root.textContent =
        'Mail could not be loaded. Open the URL printed by the mail-ui command.';
    }
  }
};
void start();
