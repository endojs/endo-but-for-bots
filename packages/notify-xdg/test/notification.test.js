// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';

import { make, notificationToDict } from '../src/notification.js';

/** @import { RemoteFunction } from '@endo/eventual-send' */

/**
 * Create a mock DBusSock for testing.
 * Uses a plain object (not an exo) since E() handles eventual sends
 * to any object.
 * @param {object} [opts]
 * @param {(payload: string) => boolean} [opts.shouldReject]
 * @returns {{ exo: object, calls: Array<{ method: string; args: unknown[] }> }}
 */
const makeMockDBusSock = (opts = {}) => {
  const calls = [];

  const exo = harden({
    async connect() {
      calls.push({ method: 'connect', args: [] });
    },
    async authenticate() {
      calls.push({ method: 'authenticate', args: [] });
    },
    async hello() {
      calls.push({ method: 'hello', args: [] });
    },
    /**
     * @param {string} payload
     * @param {number} [_timeoutMs]
     * @returns {Promise<string>}
     */
    async callMethod(payload, _timeoutMs = 3000) {
      calls.push({ method: 'callMethod', args: [payload] });

      if (opts.shouldReject && opts.shouldReject(payload)) {
        throw Error('mock reject');
      }

      // Return a minimal valid method-return with u32 body = 42
      const reply = new Uint8Array(24);
      const dv = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      reply[0] = 0x6c;
      reply[1] = 2; // METHOD_RETURN
      reply[2] = 0;
      reply[3] = 1;
      dv.setUint32(4, 4, true); // body len = 4
      dv.setUint32(8, 1, true); // reply serial
      dv.setUint32(12, 0, true); // header fields len = 0
      dv.setUint32(16, 42, true); // body = notification ID 42
      return encodeBase64(reply);
    },
    close() {
      calls.push({ method: 'close', args: [] });
    },
  });

  return { exo, calls };
};

/** @param {object} dbusSock */
const makePowers = dbusSock =>
  harden({
    lookup: name => {
      if (name === 'dbus-sock') return dbusSock;
      throw Error(`unknown name: ${name}`);
    },
  });

// ---------------------------------------------------------------------------
// Pure function tests (notificationToDict)
// ---------------------------------------------------------------------------

test('notificationToDict with title only', t => {
  const dict = notificationToDict({ title: 'Hello' });
  t.deepEqual(dict.title, ['s', 'Hello']);
});

test('notificationToDict with body only', t => {
  const dict = notificationToDict({ body: 'World' });
  t.deepEqual(dict.body, ['s', 'World']);
});

test('notificationToDict with title and body', t => {
  const dict = notificationToDict({ title: 'T', body: 'B' });
  t.deepEqual(dict, { title: ['s', 'T'], body: ['s', 'B'] });
});

test('notificationToDict with priority', t => {
  const dict = notificationToDict({ priority: 'urgent' });
  t.deepEqual(dict.priority, ['s', 'urgent']);
});

test('notificationToDict with category', t => {
  const dict = notificationToDict({ category: 'im.received' });
  t.deepEqual(dict.category, ['s', 'im.received']);
});

test('notificationToDict with default action', t => {
  const dict = notificationToDict({ 'default-action': 'view' });
  t.deepEqual(dict['default-action'], ['s', 'view']);
});

test('notificationToDict with string target', t => {
  const dict = notificationToDict({
    'default-action': 'open',
    'default-action-target': 'https://example.com',
  });
  t.deepEqual(dict['default-action-target'], ['s', 'https://example.com']);
});

test('notificationToDict with buttons', t => {
  const dict = notificationToDict({
    buttons: [{ label: 'OK', action: 'ok' }, { action: 'cancel' }],
  });
  t.deepEqual(dict.buttons, [
    'aa{sv}',
    [{ label: ['s', 'OK'], action: ['s', 'ok'] }, { action: ['s', 'cancel'] }],
  ]);
});

test('notificationToDict with empty input', t => {
  const dict = notificationToDict({});
  t.deepEqual(dict, {});
});

test('notificationToDict result is hardened', t => {
  const result = notificationToDict({ title: 'x' });
  t.true(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// Exo plugin tests
// ---------------------------------------------------------------------------

test('notification plugin make rejects missing dbus-sock in powers', async t => {
  /** @type {{ lookup: () => never }} */
  const badPowers = {
    lookup: () => {
      throw Error('not found');
    },
  };
  await t.throwsAsync(() => make(badPowers), {
    message: /not found/,
  });
});

test('notification plugin make succeeds with valid powers', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  t.truthy(daemon, 'must return a notification daemon');
});

test('notification addNotification sends AddNotification', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  await E(daemon).addNotification('test-1', {
    title: 'Test Title',
    body: 'Test Body',
  });

  t.true(mock.calls.length >= 1, 'must make a D-Bus method call');

  // First call should be the notification method.
  const helloCall = mock.calls.find(c => c.method === 'callMethod');
  if (!helloCall) {
    t.fail('first call must be callMethod');
    return;
  }
  t.true(typeof helloCall.args[0] === 'string');
});

test('notification addNotification sends base64 payloads to dbus-sock', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  await E(daemon).addNotification('test-b64', { title: 'Base64' });

  const helloCall = /** @type {{ method: string; args: unknown[] }} */ (
    mock.calls.find(c => c.method === 'callMethod')
  );
  if (!helloCall) {
    t.fail('expected a callMethod call');
    return;
  }
  const decoded = decodeBase64(/** @type {string} */ (helloCall.args[0]));
  t.is(decoded[0], 0x6c);
});

test('notification relies on dbus-sock readiness for the initial hello', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  await E(daemon).addNotification('test-init', { title: 'Init' });

  t.deepEqual(
    mock.calls.slice(0, 3).map(call => call.method),
    ['connect', 'authenticate', 'hello'],
  );
});

test('notification plugin addNotification returns 0 on portal path', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  const result = await E(daemon).addNotification('test-2', {
    title: 'Portal test',
  });

  t.is(result, 0);
});

test('notification daemon close calls dbus-sock close', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  await E(daemon).close();

  const closeCall = mock.calls.find(c => c.method === 'close');
  t.truthy(closeCall, 'dbus-sock.close() must be invoked');
});

test('notification removeNotification sends through dbus-sock', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  await E(daemon).removeNotification('test-3');

  // Hello + RemoveNotification = at least 1 callMethod
  t.true(mock.calls.filter(c => c.method === 'callMethod').length >= 1);
});

test('notification getSupportedOptions returns empty object', async t => {
  const mock = makeMockDBusSock();
  const powers = makePowers(mock.exo);

  const daemon = await make(powers);
  const opts = await E(daemon).getSupportedOptions();
  t.deepEqual(opts, {});
});
