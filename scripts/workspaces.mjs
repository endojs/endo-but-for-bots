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
  const rootManifest = JSON.parse(
    await readFile(path.join(rootDir, 'package.json'), 'utf8'),
  );
  const declaredWorkspaces = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;
  if (!Array.isArray(declaredWorkspaces)) {
    throw new Error('package.json must declare an array of workspaces');
  }
  const locations = new Set();
  await Promise.all(
    declaredWorkspaces.map(async workspacePattern => {
      const match = /^([^*]+)\/\*$/.exec(workspacePattern);
      if (!match) {
        throw new Error(
          `Unsupported workspace pattern ${JSON.stringify(workspacePattern)}`,
        );
      }
      const workspaceDirectory = match[1];
      const entries = await readdir(path.join(rootDir, workspaceDirectory), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          locations.add(path.join(workspaceDirectory, entry.name));
        }
      }
    }),
  );
  const workspaces = await Promise.all(
    [...locations].map(async location => {
      const manifestPath = path.join(rootDir, location, 'package.json');
      const source = await readFile(manifestPath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (source === undefined) return undefined;
      const manifest = JSON.parse(source);
      if (typeof manifest.name !== 'string') return undefined;
      return {
        location,
        name: manifest.name,
        private: Boolean(manifest.private),
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
