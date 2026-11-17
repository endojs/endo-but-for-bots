// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { makeCapTP } from '@endo/captp';
import { Far } from '@endo/far';
import { E } from '@endo/eventual-send';
import { connectToAndroid } from '../../android-connection.js';

test('reconnect reacquires local host and ignores callbacks from the old socket', async t => {
  t.timeout(5000);
  const peers = new Map();
  const host = Far('PhoneHost', { identity: () => 'persisted-phone-identity' });
  /** @type {{ onmessage: ((event: {data: string}) => void) | null, postMessage: (raw: string) => void }} */
  const bridge = {
    onmessage: null,
    postMessage: raw => {
      const event = JSON.parse(raw);
      const deliver = (type, data = '') =>
        queueMicrotask(() =>
          bridge.onmessage?.({
            data: JSON.stringify({ id: event.id, type, data }),
          }),
        );
      if (event.type === 'open') {
        peers.set(
          event.id,
          makeCapTP(
            `Daemon-${event.id}`,
            message => deliver('message', JSON.stringify(message)),
            Far('Bootstrap', { host: () => host }),
          ),
        );
        deliver('ready');
      } else if (event.type === 'message')
        peers.get(event.id).dispatch(JSON.parse(event.data));
      else if (event.type === 'close') peers.get(event.id)?.abort();
    },
  };
  const first = connectToAndroid(bridge, 'first');
  t.is(await E(await first.powers).identity(), 'persisted-phone-identity');
  bridge.onmessage?.({ data: JSON.stringify({ id: 'first', type: 'closed' }) });
  await first.closed;
  const second = connectToAndroid(bridge, 'second');
  t.teardown(() => second.close());
  bridge.onmessage?.({ data: JSON.stringify({ id: 'first', type: 'closed' }) });
  t.is(await E(await second.powers).identity(), 'persisted-phone-identity');
});
