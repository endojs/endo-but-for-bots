// @ts-check

import { makeCapTP } from '@endo/captp';
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';

/**
 * Connect the shared UI to the app's own daemon, never a remote host bootstrap.
 * A fresh connection identity fences callbacks from a previous WebView/socket.
 * @param {{ postMessage: (message: string) => void,
 *   onmessage: ((event: {data: string}) => void) | null }} bridge
 * @param {string} id
 */
export const connectToAndroid = (bridge, id) => {
  const powers = makePromiseKit();
  const closed = makePromiseKit();
  let ended = false;
  let ready = false;
  const send = (/** @type {string} */ type, /** @type {string} */ data = '') =>
    bridge.postMessage(JSON.stringify({ id, type, data }));
  const captp = makeCapTP('Android Chat', message => {
    if (!ended) send('message', JSON.stringify(message));
  });
  const close = (error = Error('Local Endo connection closed')) => {
    if (ended) return;
    ended = true;
    powers.reject(error);
    captp.abort(error);
    closed.resolve(undefined);
    send('close');
  };
  bridge.onmessage = event => {
    if (ended) return;
    try {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      if (message.type === 'ready' && !ready) {
        ready = true;
        E(captp.getBootstrap())
          .host()
          .then(powers.resolve, error => close(error));
      } else if (message.type === 'message' && ready) {
        captp.dispatch(JSON.parse(message.data));
      } else if (message.type === 'closed') {
        close(Error(message.data || 'Local Endo disconnected'));
      }
    } catch (error) {
      close(/** @type {Error} */ (error));
    }
  };
  send('open');
  return harden({ powers: powers.promise, closed: closed.promise, close });
};
harden(connectToAndroid);
