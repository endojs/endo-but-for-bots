// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  serialise,
  newMethodCall,
  buildHelloPayload,
  withSerial,
  parseMessage,
  MESSAGE_TYPE_METHOD_CALL,
  MESSAGE_TYPE_METHOD_RETURN,
  MESSAGE_TYPE_SIGNAL,
  FIELD_PATH,
  FIELD_INTERFACE,
  FIELD_MEMBER,
  FIELD_DESTINATION,
  FIELD_SIGNATURE,
} from '../src/dbus-msg.js';

test('buildHelloPayload starts with little-endian byte', t => {
  const pkt = buildHelloPayload();
  t.is(pkt[0], 0x6c, 'first byte must be little-endian marker');
});

test('buildHelloPayload returns a Uint8Array', t => {
  const pkt = buildHelloPayload();
  t.true(pkt instanceof Uint8Array);
});

test('buildHelloPayload has method-call type byte', t => {
  const pkt = buildHelloPayload();
  t.is(pkt[1], MESSAGE_TYPE_METHOD_CALL, 'type byte must be 1 (method call)');
});

test('buildHelloPayload has protocol version 1', t => {
  const pkt = buildHelloPayload();
  t.is(pkt[3], 1, 'protocol version must be 1');
});

test('serialise creates well-formed header with path and interface', t => {
  const headers = new Map();
  headers.set(FIELD_PATH, '/com/example');
  headers.set(FIELD_INTERFACE, 'com.example');
  headers.set(FIELD_MEMBER, 'Ping');

  const pkt = serialise(MESSAGE_TYPE_METHOD_CALL, 1, headers, '', []);

  // Header fields start at offset 16 (after: endian,type,flags,proto,bodyLen,serial,fieldsLen)
  const fieldsLen = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
    .getUint32(12, true);
  t.true(fieldsLen > 0, 'header fields must have non-zero length');
});

test('serialise embeds body data correctly', t => {
  const headers = new Map();
  headers.set(FIELD_PATH, '/');
  headers.set(FIELD_DESTINATION, 'x.y.z');
  headers.set(FIELD_INTERFACE, 'x.y.z');
  headers.set(FIELD_MEMBER, 'Foo');
  headers.set(FIELD_SIGNATURE, 's');

  const pkt = serialise(MESSAGE_TYPE_METHOD_CALL, 2, headers, 's', ['hello']);

  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const bodyLen = dv.getUint32(4, true);
  t.is(bodyLen > 0, true, 'body length must be reported correctly');

  // Decode string from body
  const fieldsLen = dv.getUint32(12, true);
  const bodyOff = Math.ceil((16 + fieldsLen) / 8) * 8;
  const strLen = dv.getUint32(bodyOff, true);
  const strBytes = new Uint8Array(
    pkt.buffer,
    pkt.byteOffset + bodyOff + 4,
    strLen,
  );
  const decoded = new TextDecoder().decode(strBytes);
  t.is(decoded, 'hello', 'body must contain serialised string');
});

test('newMethodCall produces correct structure for Notify signature', t => {
  const pkt = newMethodCall(
    {
      objectPath: '/org/freedesktop/Notifications',
      busName: 'org.freedesktop.Notifications',
      interface: 'org.freedesktop.Notifications',
    },
    'Notify',
    'susssasa{sv}i',
    ['test-app', 0, '', 'Summary', 'Body', [], {}, -1],
    2,
  );

  t.is(pkt[0], 0x6c, 'endianness');
  t.is(pkt[1], MESSAGE_TYPE_METHOD_CALL, 'method call type');
  t.is(pkt[3], 1, 'protocol version');

  // Verify the body is present and non-trivial
  const bodyLen = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
    .getUint32(4, true);
  t.true(bodyLen > 0, 'Notify payload must have a body');
});

test('newMethodCall with empty body', t => {
  const pkt = newMethodCall(
    { objectPath: '/', busName: 'c.d', interface: 'c.d' },
    'Bar',
  );
  const bodyLen = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
    .getUint32(4, true);
  t.is(bodyLen, 0, 'no-body method call has zero body length');
});

test('newMethodCall returns a Uint8Array', t => {
  const pkt = newMethodCall(
    { objectPath: '/', busName: 'c.d', interface: 'c.d' },
    'Bar',
  );
  t.true(pkt instanceof Uint8Array);
});

test('withSerial patches the serial field of a message', t => {
  const pkt = newMethodCall(
    { objectPath: '/', busName: 'c.d', interface: 'c.d' },
    'Bar',
  );
  const patched = withSerial(pkt, 17);
  const message = parseMessage(patched);
  t.is(message.serial, 17);
});

test('parseMessage decodes a method-return carrying an object path', t => {
  const headers = new Map();
  headers.set(FIELD_SIGNATURE, 'o');
  const pkt = serialise(
    MESSAGE_TYPE_METHOD_RETURN,
    7,
    headers,
    'o',
    ['/org/freedesktop/portal/desktop/request/1_99/token'],
  );

  const message = parseMessage(pkt);
  t.is(message.messageType, MESSAGE_TYPE_METHOD_RETURN);
  t.is(message.serial, 7);
  t.is(
    message.body[0],
    '/org/freedesktop/portal/desktop/request/1_99/token',
  );
});

test('parseMessage decodes a portal response signal body', t => {
  const headers = new Map();
  headers.set(
    FIELD_PATH,
    '/org/freedesktop/portal/desktop/request/1_99/token',
  );
  headers.set(FIELD_INTERFACE, 'org.freedesktop.portal.Request');
  headers.set(FIELD_MEMBER, 'Response');
  headers.set(FIELD_SIGNATURE, 'ua{sv}');
  const pkt = serialise(MESSAGE_TYPE_SIGNAL, 9, headers, 'ua{sv}', [
    0,
    {
      uris: ['as', ['file:///tmp/demo.txt']],
      choices: ['a{ss}', { encoding: 'utf-8' }],
    },
  ]);

  const message = parseMessage(pkt);
  t.is(message.messageType, MESSAGE_TYPE_SIGNAL);
  t.is(message.headers.get(FIELD_MEMBER), 'Response');
  t.deepEqual(message.body, [
    0,
    {
      uris: ['as', ['file:///tmp/demo.txt']],
      choices: ['a{ss}', { encoding: 'utf-8' }],
    },
  ]);
});

test('parseMessage decodes nested current_filter variant body', t => {
  const headers = new Map();
  headers.set(
    FIELD_PATH,
    '/org/freedesktop/portal/desktop/request/1_99/token',
  );
  headers.set(FIELD_INTERFACE, 'org.freedesktop.portal.Request');
  headers.set(FIELD_MEMBER, 'Response');
  headers.set(FIELD_SIGNATURE, 'ua{sv}');
  const pkt = serialise(MESSAGE_TYPE_SIGNAL, 10, headers, 'ua{sv}', [
    0,
    {
      current_filter: [
        '(sa(us))',
        ['Images', [[0, '*.png'], [1, 'image/jpeg']]],
      ],
    },
  ]);

  const message = parseMessage(pkt);
  t.deepEqual(message.body, [
    0,
    {
      current_filter: [
        '(sa(us))',
        ['Images', [[0, '*.png'], [1, 'image/jpeg']]],
      ],
    },
  ]);
});
