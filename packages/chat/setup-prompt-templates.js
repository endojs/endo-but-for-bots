// @ts-check
/* global process */
// endo run --UNCONFINED setup-prompt-templates.js --powers @agent
// Optional: PROMPT_TEMPLATES_CWD=/path/to/project to scan that project instead
// of the current directory.
//
// Grants Chat read-only access to the prompt template directories that exist
// on this machine. Chat lists a template as a `/` command and rereads the
// directories each time `/` opens the menu, so run this again only when the
// set of directories changes or to scan a different project.

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';

import { E } from '@endo/eventual-send';
import { listPromptTemplateDirectories } from '@endo/prompt-templates/node.js';
import { PROMPT_TEMPLATES_PET_NAME } from '@endo/spaces-util/prompt-template-catalog.js';

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
const isDirectory = path =>
  stat(path).then(
    stats => stats.isDirectory(),
    () => false,
  );

/**
 * @param {ERef<EndoHost>} agent
 */
export const main = async agent => {
  const directories = await listPromptTemplateDirectories({
    homeDirectory: homedir(),
    workingDirectory: process.env.PROMPT_TEMPLATES_CWD || process.cwd(),
  });
  const present = await Promise.all(directories.map(isDirectory));

  if (await E(agent).has(PROMPT_TEMPLATES_PET_NAME)) {
    await E(agent).remove(PROMPT_TEMPLATES_PET_NAME);
  }
  await E(agent).makeDirectory(PROMPT_TEMPLATES_PET_NAME);

  const granted = directories.filter((_directory, index) => present[index]);
  // Chat reads these in sorted order, so the zero-padded index preserves the
  // lowest-to-highest precedence of `directories`.
  await Promise.all(
    granted.map((directory, index) =>
      E(agent).provideMount(
        directory,
        [PROMPT_TEMPLATES_PET_NAME, `source-${String(index).padStart(3, '0')}`],
        { readOnly: true },
      ),
    ),
  );

  console.log(
    `[setup-prompt-templates] Granted ${granted.length} of ${directories.length} directories:`,
    granted,
  );
};
