// @ts-check
/* global document, window, location */
import '@endo/init';
import {
  connectApplication,
  parseApplicationConfig,
} from '../src/application.js';
import { makeCounterClient } from '../src/counter-client.js';

const value = /** @type {HTMLOutputElement} */ (
  document.getElementById('value')
);
const status = /** @type {HTMLElement} */ (document.getElementById('status'));
const increment = /** @type {HTMLButtonElement} */ (
  document.getElementById('increment')
);
const reconnect = /** @type {HTMLButtonElement} */ (
  document.getElementById('reconnect')
);
try {
  const config = parseApplicationConfig(location.hash);
  if (!Object.hasOwn(config.endowments, 'counter'))
    throw new Error('Open this page with a counter endowment.');
  const client = makeCounterClient({
    connect: () => connectApplication(config),
    render(state) {
      if (state.value !== undefined) value.textContent = String(state.value);
      status.textContent = state.status;
      increment.disabled = !state.canIncrement;
    },
  });
  increment.onclick = () => {
    client.increment().catch(() => {});
  };
  reconnect.onclick = () => {
    client.connect().catch(() => {});
  };
  window.addEventListener('pagehide', client.close);
  client.connect().catch(() => {});
} catch {
  status.textContent =
    'Open this page with a counter endowment and relay configuration in its URL fragment.';
  reconnect.disabled = true;
}
