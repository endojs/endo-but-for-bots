// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';

import { make } from '../src/filechooser.js';
import {
  FIELD_INTERFACE,
  FIELD_MEMBER,
  FIELD_PATH,
  FIELD_SIGNATURE,
  MESSAGE_TYPE_METHOD_RETURN,
  MESSAGE_TYPE_SIGNAL,
  parseMessage,
  serialise,
} from '../src/dbus-msg.js';
import {
  parseRequestHandle,
  parseResponseSignal,
} from '../src/portal-request.js';

const REQUEST_PATH = '/org/freedesktop/portal/desktop/request/1_99/token';

/**
 * @returns {string}
 */
const methodReturnHandle = () => {
  const headers = new Map();
  headers.set(FIELD_SIGNATURE, 'o');
  const bytes = serialise(
    MESSAGE_TYPE_METHOD_RETURN,
    11,
    headers,
    'o',
    [REQUEST_PATH],
  );
  return encodeBase64(bytes);
};

/**
 * @param {string} path
 * @param {number} responseCode
 * @param {Record<string, [string, unknown]>} results
 * @returns {string}
 */
const responseSignal = (path, responseCode, results) => {
  const headers = new Map();
  headers.set(FIELD_PATH, path);
  headers.set(FIELD_INTERFACE, 'org.freedesktop.portal.Request');
  headers.set(FIELD_MEMBER, 'Response');
  headers.set(FIELD_SIGNATURE, 'ua{sv}');
  const bytes = serialise(MESSAGE_TYPE_SIGNAL, 12, headers, 'ua{sv}', [
    responseCode,
    results,
  ]);
  return encodeBase64(bytes);
};

/**
 * @param {object} [opts]
 * @param {string[]} [opts.readMessages]
 * @returns {{ exo: object, calls: Array<{ method: string; args: unknown[] }> }}
 */
const makeMockDBusSock = (opts = {}) => {
  const calls = [];
  const queuedReadMessages = [...(opts.readMessages || [])];
  const queuedMethodReplies = [
    methodReturnHandle(),
    methodReturnHandle(),
    methodReturnHandle(),
  ];

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
      return queuedMethodReplies.shift() || methodReturnHandle();
    },
    /**
     * @param {number} [_timeoutMs]
     * @returns {Promise<string>}
     */
    async readMessage(_timeoutMs = 3000) {
      calls.push({ method: 'readMessage', args: [_timeoutMs] });
      const next = queuedReadMessages.shift();
      if (next === undefined) {
        throw Error('no queued read message');
      }
      return next;
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

test('parseRequestHandle reads object-path method return', t => {
  t.is(parseRequestHandle(methodReturnHandle()), REQUEST_PATH);
});

test('parseResponseSignal decodes response code and uris', t => {
  const payload = responseSignal(REQUEST_PATH, 0, {
    uris: ['as', ['file:///tmp/demo.txt']],
  });
  const signal = parseResponseSignal(payload);
  t.is(signal.path, REQUEST_PATH);
  t.deepEqual(signal.response, {
    response: 0,
    results: {
      uris: ['as', ['file:///tmp/demo.txt']],
    },
  });
});

test('file chooser openFile decodes current_filter response', async t => {
  const mock = makeMockDBusSock({
    readMessages: [
      responseSignal(REQUEST_PATH, 0, {
        current_filter: [
          '(sa(us))',
          ['Images', [[0, '*.png'], [1, 'image/jpeg']]],
        ],
      }),
    ],
  });
  const chooser = await make(makePowers(mock.exo));

  const result = await E(chooser).openFile('', 'Choose a file', {});

  t.deepEqual(result, {
    response: 0,
    results: {
      current_filter: ['Images', [[0, '*.png'], [1, 'image/jpeg']]],
    },
  });
});

test('file chooser openFile sends OpenFile and waits for matching signal', async t => {
  const mock = makeMockDBusSock({
    readMessages: [
      responseSignal('/org/freedesktop/portal/desktop/request/1_99/other', 1, {
        uris: ['as', ['file:///tmp/skip.txt']],
      }),
      responseSignal(REQUEST_PATH, 0, {
        uris: ['as', ['file:///tmp/chosen.txt']],
      }),
    ],
  });
  const chooser = await make(makePowers(mock.exo));

  const result = await E(chooser).openFile('', 'Choose a file', {});

  t.deepEqual(result, {
    response: 0,
    results: {
      uris: ['file:///tmp/chosen.txt'],
    },
  });
  t.deepEqual(
    mock.calls.map(call => call.method),
    [
      'connect',
      'authenticate',
      'hello',
      'callMethod',
      'callMethod',
      'readMessage',
      'readMessage',
    ],
  );

  const openCall = /** @type {string} */ (mock.calls[3].args[0]);
  const openMessage = parseMessage(decodeBase64(openCall));
  t.is(openMessage.headers.get(FIELD_MEMBER), 'OpenFile');
  t.deepEqual(openMessage.body, ['', 'Choose a file', {}]);

  const addMatchCall = /** @type {string} */ (mock.calls[4].args[0]);
  const addMatchMessage = parseMessage(decodeBase64(addMatchCall));
  t.is(addMatchMessage.headers.get(FIELD_MEMBER), 'AddMatch');
  t.is(
    addMatchMessage.body[0],
    "type='signal',interface='org.freedesktop.portal.Request',member='Response',path='/org/freedesktop/portal/desktop/request/1_99/token'",
  );
  t.deepEqual(
    mock.calls
      .filter(call => call.method === 'readMessage')
      .map(call => call.args[0]),
    [30000, 30000],
  );
});

test('file chooser openFile encodes options as a{sv} variants', async t => {
  const mock = makeMockDBusSock({
    readMessages: [
      responseSignal(REQUEST_PATH, 0, {
        uris: ['as', ['file:///tmp/chosen.txt']],
      }),
    ],
  });
  const chooser = await make(makePowers(mock.exo));

  await E(chooser).openFile('', 'Choose a file', { multiple: true });

  const openCall = /** @type {string} */ (mock.calls[3].args[0]);
  const openMessage = parseMessage(decodeBase64(openCall));
  t.deepEqual(openMessage.body, [
    '',
    'Choose a file',
    {
      multiple: ['b', true],
    },
  ]);
});
