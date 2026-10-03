// @ts-check
//
// The Node implementation of the `makeScratchDirectory` power both Claude
// backends take: one private directory per turn, holding the turn's config
// files and the empty directory the process uses as `HOME` and
// `CLAUDE_CONFIG_DIR`, removed when the turn ends.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Fail, q } from '@endo/errors';

/** @import { ScratchDirectory } from './backends.types.js' */

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {object} [options]
 * @param {string} [options.parentDirectory]  defaults to `os.tmpdir()`.
 * @returns {() => Promise<ScratchDirectory>}
 */
export const makeNodeScratchDirectoryMaker = ({
  parentDirectory = tmpdir(),
} = {}) => {
  const makeScratchDirectory = async () => {
    const path = await mkdtemp(join(parentDirectory, 'endo-claude-'));
    const configDirectory = join(path, 'config');
    await mkdir(configDirectory, { mode: 0o700 });
    return harden({
      path,
      configDirectory,
      /**
       * @param {string} name
       * @param {string} contents
       */
      writeFile: async (name, contents) => {
        SAFE_FILE_NAME.test(name) || Fail`unsafe scratch file name ${q(name)}`;
        const filePath = join(path, name);
        await writeFile(filePath, contents, { mode: 0o600, flag: 'wx' });
        return filePath;
      },
      remove: () => rm(path, { recursive: true, force: true }),
    });
  };
  return harden(makeScratchDirectory);
};
harden(makeNodeScratchDirectoryMaker);
