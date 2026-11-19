// @ts-check
/** The common successful and failed tool results, with inline or staged text. */

/** @param {any} text */
export const ok = text => harden({ status: 'ok', text });
/** @param {any} text */
export const failed = text => harden({ status: 'failed', text });
