// @ts-check

/**
 * Help documentation for Endo daemon interfaces.
 *
 * Each help object maps method names to documentation strings.
 * The special key '' (empty string) provides an overview of the interface.
 *
 * Documentation is authored in help.md and compiled to help-text-data.js by
 * scripts/generate-help-text-data.mjs with the `@endo/helpdown` scanner.
 *
 * `makeHelp` and the `HelpText` type come from `@endo/helpdown` and are
 * re-exported here, where daemon modules have always reached for them.
 */

import { makeHelp } from '@endo/helpdown';

import { helpTextEntries } from './help-text-data.js';

/** @typedef {import('@endo/helpdown').HelpText} HelpText */

export { makeHelp };

const helpMap = new Map(helpTextEntries);

/** @type {HelpText} */
export const directoryHelp = helpMap.get('EndoDirectory') || {};

/** @type {HelpText} */
export const mailHelp = helpMap.get('Mail Operations') || {};

/** @type {HelpText} */
export const guestHelp = helpMap.get('EndoGuest') || {};

/** @type {HelpText} */
export const hostHelp = helpMap.get('EndoHost') || {};

/** @type {HelpText} */
export const blobHelp = helpMap.get('EndoReadable') || {};

/** @type {HelpText} */
export const endoHelp = helpMap.get('Endo Bootstrap') || {};

/** @type {HelpText} */
export const readableTreeHelp = helpMap.get('ReadableTree') || {};

/** @type {HelpText} */
export const mountHelp = helpMap.get('EndoMount') || {};

/** @type {HelpText} */
export const mountFileHelp = helpMap.get('EndoMountFile') || {};

harden(directoryHelp);
harden(mailHelp);
harden(guestHelp);
harden(hostHelp);
harden(blobHelp);
harden(readableTreeHelp);
harden(mountHelp);
harden(mountFileHelp);
harden(endoHelp);
harden(makeHelp);
