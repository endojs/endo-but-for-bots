// @ts-check

import harden from '@endo/harden';

/**
 * Blob content is the raw file bytes; codec is identity.
 *
 * @param {Uint8Array} content
 * @returns {Uint8Array}
 */
export const parseBlob = content => content;
harden(parseBlob);

/**
 * @param {Uint8Array} content
 * @returns {Uint8Array}
 */
export const serializeBlob = content => content;
harden(serializeBlob);
