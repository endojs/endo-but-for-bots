// @ts-check

/**
 * Help documentation for the Git capability surfaces.
 *
 * Each help object maps method names to documentation strings.
 * The special key '' (empty string) provides an overview of the interface.
 *
 * Documentation is authored in help.md and compiled to help-text-data.js
 * by scripts/generate-help-text-data.mjs, the same `@endo/helpdown`
 * pipeline the daemon uses for its own interfaces.
 */

import { makeHelp } from '@endo/helpdown';

import { helpTextEntries } from './help-text-data.js';

/** @typedef {import('@endo/helpdown').HelpText} HelpText */

export { makeHelp };

const helpMap = new Map(helpTextEntries);

/** @type {HelpText} */
export const gitHelp = helpMap.get('Git') || {};

/** @type {HelpText} */
export const gitTreeHelp = helpMap.get('GitTree') || {};

/** @type {HelpText} */
export const gitBlobHelp = helpMap.get('GitBlob') || {};

/** @type {HelpText} */
export const gitRemoteHelp = helpMap.get('GitRemote') || {};

/** @type {HelpText} */
export const gitRemoteControllerHelp = helpMap.get('GitRemoteController') || {};

/** @type {HelpText} */
export const gitCredentialControllerHelp =
  helpMap.get('GitCredentialController') || {};

/** @type {HelpText} */
export const bearerCredentialHelp = helpMap.get('BearerCredential') || {};

/** @type {HelpText} */
export const basicCredentialHelp = helpMap.get('BasicCredential') || {};

harden(gitHelp);
harden(gitTreeHelp);
harden(gitBlobHelp);
harden(gitRemoteHelp);
harden(gitRemoteControllerHelp);
harden(gitCredentialControllerHelp);
harden(bearerCredentialHelp);
harden(basicCredentialHelp);
harden(makeHelp);
