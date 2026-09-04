/**
 * Packages the Familiar Electron app using \@electron/packager.
 *
 * Produces a platform-native app bundle (e.g. Familiar.app on macOS) in
 * out/Familiar-<platform>-<arch>/.
 *
 * Usage: node scripts/package-app.mjs [target-os] [target-arch]
 *
 * Both arguments are optional and default to the host platform / arch. The
 * macOS arm64 vs x64 release matrix in .github/workflows/familiar-release.yml
 * runs this script on architecture-matched runners (macos-14 for arm64,
 * macos-13 for x64); the arguments are present so the script can be invoked
 * cross-architecture if a future builder pass needs to (e.g. composing a
 * universal binary via @electron/universal, which the design tracks as a
 * post-MVR followup to G15).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarDir = path.resolve(dirname, '..');

// Determine target OS.
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform;
const targetOS = process.argv[2] || hostPlatform;
// Map the `darwin`/`linux`/`win` (or `win32`) inputs accepted by callers to
// the platform identifier @electron/packager expects (`darwin`/`linux`/`win32`).
const packagerPlatform = targetOS === 'win' ? 'win32' : targetOS;

// Determine target arch.
const targetArch = process.argv[3] || process.arch;

/**
 * Allowlist filter for files to include in the packaged app.
 * Everything not matching is excluded (node_modules, scripts, etc.).
 *
 * @param {string} filePath - Path relative to the app root.
 * @returns {boolean} True to include the file.
 */
const includeFilter = filePath => {
  // Allow the root
  if (filePath === '') return true;

  const allowed = [
    '/preload.mjs',
    '/package.json',
    '/bundles',
    '/dist',
    '/node',
    '/node.exe',
  ];

  for (const prefix of allowed) {
    if (filePath === prefix || filePath.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  return false;
};

const appPaths = await packager({
  dir: familiarDir,
  out: path.join(familiarDir, 'out'),
  overwrite: true,
  asar: false,
  name: 'Familiar',
  executableName: 'Familiar',
  icon: path.join(familiarDir, 'assets/icon'),
  platform: /** @type {any} */ (packagerPlatform),
  arch: /** @type {any} */ (targetArch),
  ignore: contents => !includeFilter(contents),
});

console.log(`Packaged app at: ${appPaths[0]}`);
