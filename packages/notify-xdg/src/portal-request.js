// @ts-check

import { decodeBase64, encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import {
  MESSAGE_TYPE_SIGNAL,
  newMethodCall,
  parseMessage,
} from './dbus-msg.js';

/** @import { DBusSock, PortalResponse } from './types.js' */

const { Fail } = assert;

export const REQUEST_INTERFACE = 'org.freedesktop.portal.Request';

/**
 * Match only the response signal for a single request path.
 * @param {string} requestPath
 * @returns {string}
 */
export const responseMatchRule = requestPath =>
  `type='signal',interface='${REQUEST_INTERFACE}',member='Response',path='${requestPath}'`;
harden(responseMatchRule);

/**
 * Parse a method-return carrying a single object path.
 * @param {string} payload
 * @returns {string}
 */
export const parseRequestHandle = payload => {
  const message = parseMessage(decodeBase64(payload));
  Array.isArray(message.body) || Fail`D-Bus body must be an array`;
  const [handle] = message.body;
  typeof handle === 'string' || Fail`Request handle must be a string`;
  return /** @type {string} */ (handle);
};
harden(parseRequestHandle);

/**
 * Parse a `org.freedesktop.portal.Request.Response` signal.
 * @param {string} payload
 * @returns {{ path: string, response: PortalResponse }}
 */
export const parseResponseSignal = payload => {
  const message = parseMessage(decodeBase64(payload));
  message.messageType === MESSAGE_TYPE_SIGNAL ||
    Fail`Expected D-Bus signal, got ${message.messageType}`;
  const path = /** @type {string | undefined} */ (message.headers.get(1));
  const iface = /** @type {string | undefined} */ (message.headers.get(2));
  const member = /** @type {string | undefined} */ (message.headers.get(3));
  iface === REQUEST_INTERFACE || Fail`Unexpected signal interface: ${iface}`;
  member === 'Response' || Fail`Unexpected signal member: ${member}`;
  const signalPath =
    typeof path === 'string' ? path : Fail`Response signal missing object path`;
  const [response, results] = message.body;
  typeof response === 'number' || Fail`Response code must be a number`;
  (results && typeof results === 'object' && !Array.isArray(results)) ||
    Fail`Response results must be a dictionary`;
  const responseCode = /** @type {number} */ (response);
  const responseResults = /** @type {Record<string, unknown>} */ (results);
  return harden({
    path: signalPath,
    response: harden({
      response: responseCode,
      results: responseResults,
    }),
  });
};
harden(parseResponseSignal);

/**
 * Send a portal request, subscribe to its response signal, and wait for the
 * matching `org.freedesktop.portal.Request.Response`.
 *
 * @param {DBusSock} dbusSock
 * @param {Uint8Array} requestPayload
 * @param {number} timeoutMs
 * @returns {Promise<PortalResponse>}
 */
export const makePortalRequest = async (
  dbusSock,
  requestPayload,
  timeoutMs,
) => {
  const requestReply = await E(dbusSock).callMethod(
    encodeBase64(requestPayload),
  );
  const handle = parseRequestHandle(requestReply);

  const addMatchPayload = newMethodCall(
    {
      objectPath: '/org/freedesktop/DBus',
      busName: 'org.freedesktop.DBus',
      interface: 'org.freedesktop.DBus',
    },
    'AddMatch',
    's',
    [responseMatchRule(handle)],
  );
  await E(dbusSock).callMethod(encodeBase64(addMatchPayload));

  // The bus may deliver unrelated signals; only the matching request path
  // completes this portal request.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const signalPayload = await E(dbusSock).readMessage(timeoutMs);
    const message = parseResponseSignal(signalPayload);
    if (message.path === handle) {
      return message.response;
    }
  }
};
harden(makePortalRequest);
