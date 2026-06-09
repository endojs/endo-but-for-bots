// @ts-check

/**
 * @file Endo daemon plugin: XDG Desktop Portal file chooser.
 *
 * Design constraints come from:
 * - XDG Desktop Portal `org.freedesktop.portal.FileChooser` documentation,
 *   2025.
 *   https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html
 * - XDG Desktop Portal `org.freedesktop.portal.Request` documentation,
 *   2025.
 *   https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html
 *
 * `OpenFile` returns a request handle as a D-Bus object path. Completion is
 * asynchronous and arrives later as a `Response` signal on that request path.
 */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { newMethodCall } from './dbus-msg.js';
import { makePortalRequest } from './portal-request.js';

/** @import { AsPassable, DBusSock, FileChooser, FileChooserOpenOptions, FileChooserOpenResults, FileChooserResponse, PortalResponse } from './types.js' */

const { Fail } = assert;

const FILE_CHOOSER_ADDR = harden({
  objectPath: '/org/freedesktop/portal/desktop',
  busName: 'org.freedesktop.portal.Desktop',
  interface: 'org.freedesktop.portal.FileChooser',
});

const RESPONSE_TIMEOUT_MS = 30000;

const FileChooserI = M.interface('FileChooser', {
  openFile: M.callWhen(M.string(), M.string())
    .optional(M.record())
    .returns(M.record()),
  close: M.callWhen().returns(M.undefined()),
});

/**
 * @param {FileChooserOpenOptions} options
 * @returns {Record<string, [string, unknown]>}
 */
const fileChooserOptionsToDict = options =>
  harden({
    ...(options.handle_token !== undefined && {
      handle_token: ['s', options.handle_token],
    }),
    ...(options.accept_label !== undefined && {
      accept_label: ['s', options.accept_label],
    }),
    ...(options.modal !== undefined && { modal: ['b', options.modal] }),
    ...(options.multiple !== undefined && {
      multiple: ['b', options.multiple],
    }),
    ...(options.directory !== undefined && {
      directory: ['b', options.directory],
    }),
    ...(options.filters !== undefined && {
      filters: ['a(sa(us))', options.filters],
    }),
    ...(options.current_filter !== undefined && {
      current_filter: ['(sa(us))', options.current_filter],
    }),
    ...(options.choices !== undefined && {
      choices: ['a(ssa(ss)s)', options.choices],
    }),
    ...(options.current_folder !== undefined && {
      current_folder: ['ay', options.current_folder],
    }),
  });
harden(fileChooserOptionsToDict);

const asPassableImpl = (sig, value) => {
  if (value === undefined) {
    return undefined;
  }
  switch (sig) {
    case 'as': {
      Array.isArray(value) ||
        Fail`Expected ${sig} variant payload to be an array`;
      const pair = /** @type {unknown[]} */ (value);
      pair[0] === 'as' || Fail`Expected ${sig} variant signature as`;
      Array.isArray(pair[1]) ||
        Fail`Expected ${sig} variant content to be an array`;
      return /** @type {readonly string[]} */ (pair[1]);
    }
    case 'a(ss)': {
      Array.isArray(value) ||
        Fail`Expected ${sig} variant payload to be an array`;
      const pair = /** @type {unknown[]} */ (value);
      pair[0] === 'a(ss)' || Fail`Expected ${sig} variant signature a(ss)`;
      Array.isArray(pair[1]) ||
        Fail`Expected ${sig} variant content to be an array`;
      return harden(
        Object.fromEntries(
          /** @type {readonly (readonly [string, string])[]} */ (pair[1]),
        ),
      );
    }
    case '(sa(us))': {
      Array.isArray(value) ||
        Fail`Expected ${sig} variant payload to be an array`;
      const pair = /** @type {unknown[]} */ (value);
      pair[0] === '(sa(us))' ||
        Fail`Expected ${sig} variant signature (sa(us))`;
      Array.isArray(pair[1]) ||
        Fail`Expected ${sig} variant content to be an array`;
      const filter = /** @type {unknown[]} */ (pair[1]);
      typeof filter[0] === 'string' ||
        Fail`Expected ${sig} filter name to be a string`;
      Array.isArray(filter[1]) ||
        Fail`Expected ${sig} filter rules to be an array`;
      return harden([
        filter[0],
        /** @type {readonly (readonly [0 | 1, string])[]} */ (filter[1]),
      ]);
    }
    default:
      return Fail`Unsupported D-Bus signature ${sig}`;
  }
};
/** @type {AsPassable} */
const asPassable = /** @type {AsPassable} */ (asPassableImpl);
harden(asPassable);

/**
 * @param {PortalResponse} response
 * @returns {FileChooserResponse}
 */
const normalizeFileChooserResponse = response => {
  const { results } = response;
  /** @type {FileChooserOpenResults} */
  const normalizedResults = harden({
    ...(results.uris !== undefined && {
      uris: asPassable('as', results.uris),
    }),
    ...(results.choices !== undefined && {
      choices: asPassable('a(ss)', results.choices),
    }),
    ...(results.current_filter !== undefined && {
      current_filter: asPassable('(sa(us))', results.current_filter),
    }),
  });
  return harden({
    response: response.response,
    results: normalizedResults,
  });
};
harden(normalizeFileChooserResponse);

/**
 * Create a FileChooser portal wrapper.
 *
 * The `powers` object must provide a `lookup` that resolves `dbus-sock`
 * to a connected `DBusSock`.
 *
 * @param {object} powers
 * @returns {Promise<FileChooser>}
 */
export const make = async powers => {
  /** @type {DBusSock} */
  const dbusSock = await E(powers).lookup('dbus-sock');
  void E(dbusSock).connect();
  void E(dbusSock).authenticate();
  void E(dbusSock).hello();

  return makeExo('FileChooser', FileChooserI, {
    /**
     * Open the portal file chooser and wait for the asynchronous response.
     * @param {string} parentWindow
     * @param {string} title
     * @param {FileChooserOpenOptions} [options]
     * @returns {Promise<FileChooserResponse>}
     */
    async openFile(parentWindow, title, options = {}) {
      const response = await makePortalRequest(
        dbusSock,
        newMethodCall(FILE_CHOOSER_ADDR, 'OpenFile', 'ssa{sv}', [
          parentWindow,
          title,
          fileChooserOptionsToDict(options),
        ]),
        RESPONSE_TIMEOUT_MS,
      );
      return normalizeFileChooserResponse(response);
    },

    /**
     * Close the underlying D-Bus socket.
     * @returns {Promise<void>}
     */
    async close() {
      await E(dbusSock).close();
    },
  });
};
harden(make);
