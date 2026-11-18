// @ts-check
/**
 * The list of feature modules and shell views, for Node (tests). The
 * browser bundle never contains this file: `ui/build.mjs` replaces it with a
 * generated module of static imports of the same files (`listUiModules`
 * there), so the bundle and Node see the same features.
 *
 * - `featureEntries`: every `ui/src/<dir>/feature.js`, directory-name order.
 * - `viewModules`: the shell's region views, `ui/src/sessions/index.js`
 *   (`Sidebar`, `NewSession`) and `ui/src/conversation/index.js`
 *   (`Conversation`, ...), each `undefined` while its directory has no
 *   `index.js` (they are built by W3.5 and W3.6 after the shell).
 */

/** @type {Array<{ dir: string, module: Record<string, any> }>} */
let entries = [];
/** @type {{ sessions?: Record<string, any>, conversation?: Record<string, any> }} */
let views = {};

const isNode =
  typeof globalThis.process === 'object' &&
  globalThis.process !== null &&
  typeof globalThis.process.versions === 'object' &&
  typeof globalThis.process.versions.node === 'string';

if (isNode) {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const srcDir = url.fileURLToPath(new URL('.', import.meta.url));
  const dirs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const loaded = [];
  for (const dir of dirs) {
    if (fs.existsSync(`${srcDir}${dir}/feature.js`)) {
      // eslint-disable-next-line no-await-in-loop
      const module = await import(
        new URL(`./${dir}/feature.js`, import.meta.url).href
      );
      loaded.push({ dir, module });
    }
  }
  entries = loaded;
  /** @param {string} dir */
  const view = async dir =>
    fs.existsSync(`${srcDir}${dir}/index.js`)
      ? import(new URL(`./${dir}/index.js`, import.meta.url).href)
      : undefined;
  views = {
    sessions: await view('sessions'),
    conversation: await view('conversation'),
  };
}

export const featureEntries = entries;
export const viewModules = views;
