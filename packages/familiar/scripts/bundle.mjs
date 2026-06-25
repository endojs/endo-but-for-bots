/**
 * Bundles the Endo CLI and daemon into self-contained CJS files
 * using esbuild for inclusion in the packaged Electron app.
 *
 * Each esbuild invocation also emits a metafile under
 * `bundles/.metafiles/<name>.json` that enumerates every input file
 * pulled into the bundle. The `aggregate-licenses.mjs` step consumes
 * these metafiles to enumerate third-party packages for attribution.
 */

import '@endo/init';
import fs from 'fs/promises';
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarRoot = path.resolve(dirname, '..');
const repoRoot = path.resolve(familiarRoot, '../..');
const metafileDir = path.join(familiarRoot, 'bundles/.metafiles');
await fs.mkdir(metafileDir, { recursive: true });

/**
 * Wraps esbuild's `build()` to emit a metafile alongside each bundle.
 * The metafile is written to `bundles/.metafiles/<name>.json` where
 * `<name>` derives from the outfile basename minus extension.
 *
 * @param {import('esbuild').BuildOptions} options
 */
const buildWithMetafile = async options => {
  const result = await build({ ...options, metafile: true });
  const outfile = options.outfile;
  if (!outfile) throw new Error('buildWithMetafile requires outfile');
  const base = path.basename(outfile).replace(/\.[cm]?js$/, '');
  await fs.writeFile(
    path.join(metafileDir, `${base}.json`),
    JSON.stringify(result.metafile, null, 2),
  );
};

/**
 * esbuild plugin that replaces `import.meta.url` with a CJS equivalent.
 * In CJS, `import.meta` is empty so any `new URL(..., import.meta.url)`
 * calls fail with "Invalid URL". This injects a `__filename`-based URL
 * that works in bundled CJS output.
 */
const importMetaPlugin = {
  name: 'import-meta-url',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
      const { readFile } = await import('fs/promises');
      let contents = await readFile(args.path, 'utf8');
      // Replace import.meta.url with a CJS-compatible file URL.
      // The bundle is a single file so __filename is correct.
      if (contents.includes('import.meta.url')) {
        contents = contents.replaceAll(
          'import.meta.url',
          'require("url").pathToFileURL(__filename).href',
        );
        return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
      }
      return undefined;
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // SES lockdown requires strict mode; CJS files aren't strict by default.
  banner: { js: "'use strict';" },
  // Node built-ins are external by default with platform: 'node'.
  // Mark optional native deps as external to avoid build failures.
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [importMetaPlugin],
  logLevel: 'info',
};

await buildWithMetafile({
  ...shared,
  entryPoints: [path.join(repoRoot, 'packages/cli/bin/endo.cjs')],
  outfile: path.join(familiarRoot, 'bundles/endo-cli.cjs'),
});

await buildWithMetafile({
  ...shared,
  entryPoints: [path.join(repoRoot, 'packages/daemon/src/daemon-node.js')],
  outfile: path.join(familiarRoot, 'bundles/endo-daemon.cjs'),
});

await buildWithMetafile({
  ...shared,
  entryPoints: [path.join(repoRoot, 'packages/daemon/src/worker-node.js')],
  outfile: path.join(familiarRoot, 'bundles/worker-node.cjs'),
});

await buildWithMetafile({
  ...shared,
  entryPoints: [path.join(repoRoot, 'packages/lal/setup.js')],
  outfile: path.join(familiarRoot, 'bundles/endo-lal-setup.cjs'),
});

// Lal agent caplet — loaded at runtime by the daemon worker via
// makeUnconfined.  lal/setup.js resolves it as
// new URL('agent.js', import.meta.url).
// Must be ESM: the worker import()s caplets as ES modules.
// The banner polyfills `require` for CJS deps (e.g. node-fetch)
// that esbuild cannot statically convert to ESM imports.
await buildWithMetafile({
  ...shared,
  format: 'esm',
  banner: {
    js: 'import { createRequire as __bundleCreateRequire } from "module"; const require = __bundleCreateRequire(import.meta.url);',
  },
  plugins: [],
  entryPoints: [path.join(repoRoot, 'packages/lal/agent.js')],
  outfile: path.join(familiarRoot, 'bundles/agent.js'),
});

// Copy primer directory alongside the agent bundle so that
// new URL('./primer', import.meta.url) resolves correctly.
const primerSrc = path.join(repoRoot, 'packages/lal/primer');
const primerDest = path.join(familiarRoot, 'bundles/primer');
await fs.cp(primerSrc, primerDest, { recursive: true });

await buildWithMetafile({
  ...shared,
  entryPoints: [path.join(familiarRoot, 'electron-main.js')],
  outfile: path.join(familiarRoot, 'bundles/electron-main.cjs'),
  external: [...shared.external, 'electron'],
});

console.log('Bundles created in packages/familiar/bundles/');
