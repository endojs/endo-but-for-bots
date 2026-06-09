// @ts-check

/**
 * @file Confined adapter that composes a portal FileChooser with a rooted
 * Filesystem and returns typed `File` or `Directory` caps.
 *
 * Design constraints come from:
 * - XDG Desktop Portal `org.freedesktop.portal.FileChooser` documentation,
 *   2025.
 *   https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html
 *
 * This module does not mint new filesystem authority. It narrows an existing
 * root Filesystem cap according to the user's chosen local `file:` URIs.
 */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/** @import { FileChooser, FileChooserResponse } from './types.js' */
/** @import { Directory, File, FileAccessChooser, FileAccessChooseDirectoriesOptions, FileAccessChooseFilesOptions, Filesystem } from './file-access.types.js' */
/** @import {ERef} from '@endo/eventual-send' */

const { Fail } = assert;

const FileAccessChooserI = M.interface('FileAccessChooser', {
  chooseFiles: M.callWhen(M.string(), M.string())
    .optional(M.record())
    .returns(M.array()),
  chooseDirectories: M.callWhen(M.string(), M.string())
    .optional(M.record())
    .returns(M.array()),
  close: M.callWhen().returns(M.undefined()),
});

/**
 * @param {FileChooserResponse} response
 * @returns {string[]}
 */
export const responseUris = response => {
  const { uris } = response.results;
  Array.isArray(uris) || Fail`File chooser results missing uris array`;
  const uriList = /** @type {readonly string[]} */ (uris);
  return [...uriList];
};
harden(responseUris);

/**
 * @param {string} uriText
 * @returns {string[]}
 */
export const uriToPathSegments = uriText => {
  const uri = new URL(uriText);
  uri.protocol === 'file:' || Fail`Expected file: URI, got ${uri.protocol}`;
  uri.host === '' || Fail`Expected local file URI, got host ${uri.host}`;
  return uri.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => decodeURIComponent(segment));
};
harden(uriToPathSegments);

/**
 * @param {ERef<Directory>} root
 * @param {string[]} pathSegments
 * @returns {Promise<Directory>}
 */
const lookupDirectoryPath = async (root, pathSegments) => {
  await null;
  /** @type {ERef<Directory>} */
  let current = root;
  for (const segment of pathSegments) {
    // The portal contract determines whether the selected path names a
    // directory; this walk just follows the path inside an existing root FS.
    current = /** @type {Promise<Directory>} */ (E(current).lookup(segment));
  }
  return current;
};
harden(lookupDirectoryPath);

/**
 * @param {ERef<Directory>} root
 * @param {string[]} pathSegments
 * @returns {Promise<File>}
 */
const lookupFilePath = async (root, pathSegments) => {
  await null;
  pathSegments.length > 0 || Fail`Expected non-root file path`;
  /** @type {ERef<Directory>} */
  let current = root;
  for (const segment of pathSegments.slice(0, -1)) {
    // The portal contract determines whether the selected path names a file;
    // intermediate segments must therefore resolve to directories.
    current = /** @type {Promise<Directory>} */ (E(current).lookup(segment));
  }
  return /** @type {Promise<File>} */ (
    E(current).lookup(pathSegments[pathSegments.length - 1])
  );
};
harden(lookupFilePath);

/**
 * @param {FileChooserResponse} response
 * @returns {string[]}
 */
const requireAcceptedResponse = response => {
  switch (response.response) {
    case 0: // OK
      return responseUris(response);
    case 1: // Cancel
      // eslint-disable-next-line no-throw-literal
      throw 'Cancel';
    default:
      Fail`Unexpected file chooser response code ${response.response}`;
  }
  throw Fail`Unreachable file chooser response code ${response.response}`;
};
harden(requireAcceptedResponse);

/**
 * @param {object} powers
 * @returns {Promise<FileAccessChooser>}
 */
export const make = async powers => {
  /** @type {ERef<FileChooser>} */
  const chooser = E(powers).lookup('file-chooser');
  /** @type {ERef<Filesystem>} */
  const filesystem = E(powers).lookup('root-filesystem');
  /** @type {ERef<Directory>} */
  const root = E(filesystem).root();

  return makeExo('FileAccessChooser', FileAccessChooserI, {
    /**
     * @param {string} parentWindow
     * @param {string} title
     * @param {FileAccessChooseFilesOptions} [options]
     * @returns {Promise<ERef<File>[]>}
     */
    async chooseFiles(parentWindow, title, options = {}) {
      await null;
      const response = await E(chooser).openFile(parentWindow, title, options);
      const uris = requireAcceptedResponse(response);
      return uris.map(uri => lookupFilePath(root, uriToPathSegments(uri)));
    },

    /**
     * @param {string} parentWindow
     * @param {string} title
     * @param {FileAccessChooseDirectoriesOptions} [options]
     * @returns {Promise<ERef<Directory>[]>}
     */
    async chooseDirectories(parentWindow, title, options = {}) {
      await null;
      const response = await E(chooser).openFile(parentWindow, title, {
        ...options,
        directory: true,
      });
      const uris = requireAcceptedResponse(response);
      return uris.map(uri => lookupDirectoryPath(root, uriToPathSegments(uri)));
    },

    /**
     * @returns {Promise<void>}
     */
    async close() {
      await E(chooser).close();
    },
  });
};
harden(make);
