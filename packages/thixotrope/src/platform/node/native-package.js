// @ts-check
import harden from '@endo/harden';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Pin the installed directory's contents; external dependencies use ordinary
 * module resolution and are not included in this digest. Directories contain source,
 * not node_modules. Edited packages require an explicit new installation.
 * @param {string} directory
 */
export const describeNativePackage = async directory => {
  directory = await realpath(directory);
  for (const name of ['durable.js', 'ephemeral.js']) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await lstat(join(directory, name))).isFile())
      throw Error(`Native entry ${name} must be a file`);
  }
  const hash = createHash('sha256');
  /** @param {string} relative */
  const visit = async relative => {
    const path = join(directory, relative);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      const names = (await readdir(path)).sort();
      for (const name of names) {
        if (name === 'node_modules')
          throw Error('Native package must not contain node_modules');
        // eslint-disable-next-line no-await-in-loop
        await visit(join(relative, name));
      }
    } else if (stat.isFile()) {
      const bytes = await readFile(path);
      hash.update(JSON.stringify([relative, bytes.length]));
      hash.update(bytes);
    } else {
      throw Error('Native package entries must be files or directories');
    }
  };
  await visit('');
  return harden({
    directory,
    digest: hash.digest('hex'),
    durablePath: join(directory, 'durable.js'),
    moduleUrl: pathToFileURL(join(directory, 'ephemeral.js')).href,
  });
};
harden(describeNativePackage);
