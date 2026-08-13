// @ts-check

/**
 * @import { ParsedSturdyRefUri } from '@endo/ocapn'
 */

import { parseSturdyRefUri } from '@endo/ocapn';

/**
 * @typedef {ParsedSturdyRefUri} ParsedOcapnLocator
 */

/**
 * Parse an OCapN locator URI of the form
 *   `ocapn://<designator>.<transport>[/s/<swiss>][?hint=value&...]`
 *
 * The sturdyref URI grammar now lives in `@endo/ocapn`
 * (`parseSturdyRefUri`), promoted out of goblin-chat so every OCapN
 * consumer shares one codec; this thin wrapper keeps the local
 * `parseLocator` name the TUI already imports.
 *
 * @param {string} uri
 * @returns {ParsedOcapnLocator}
 */
export const parseLocator = uri => parseSturdyRefUri(uri);
