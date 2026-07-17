import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Read the repository's declared package workspaces without depending on a
 * package-manager-specific listing command.
 *
 * @param {string} rootDir repository root
 * @returns {Promise<Array<{location: string, name: string, private: boolean}>>}
 */
export const listWorkspaces = async rootDir => {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const workspaces = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const location = path.join('packages', entry.name);
        const manifestPath = path.join(rootDir, location, 'package.json');
        const source = await readFile(manifestPath, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (source === undefined) return undefined;
        const manifest = JSON.parse(source);
        return {
          location,
          name: manifest.name,
          private: manifest.private === true,
        };
      }),
  );
  return workspaces
    .filter(workspace => workspace !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** @param {string} rootDir repository root */
export const listPublicWorkspaces = async rootDir =>
  (await listWorkspaces(rootDir)).filter(workspace => !workspace.private);
