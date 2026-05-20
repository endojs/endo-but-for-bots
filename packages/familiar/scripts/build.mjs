/**
 * Runs the Familiar build pipeline.
 *
 * Steps:
 *   1. Build chat dist (vite)
 *   2. Bundle Electron main-process code (esbuild)
 *   3. Aggregate third-party LICENSE files into bundles/
 *   4. Download Node binary for embedding
 *   5. Prepare package (copy node binary + chat dist)
 *   6. Package with @electron/packager (produces .app)
 *   7. Create distributables (DMG + zip) — skipped with --app-only
 *
 * Cross-platform: works on macOS, Linux, and Windows.
 */

/* global process */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarDir = path.resolve(dirname, '..');
const repoRoot = path.resolve(familiarDir, '../..');

const appOnly = process.argv.includes('--app-only');

const run = (cmd, cwd = familiarDir) =>
  execSync(cmd, { stdio: 'inherit', cwd, shell: true });

const step = label => {
  console.log('');
  console.log(`==> ${label}`);
  console.log('');
};

// 1. Chat dist
step('Building chat dist...');
run('yarn workspace @endo/chat build', repoRoot);

// 2. Bundle
step('Bundling Electron main-process code...');
run(`node ${JSON.stringify(path.join(dirname, 'bundle.mjs'))}`);

// 3. Aggregate licenses
step('Aggregating third-party LICENSE files...');
run(
  `node ${JSON.stringify(path.join(dirname, 'aggregate-licenses.mjs'))} --verify`,
);

// 4. Download Node
step('Downloading Node binary...');
run(`node ${JSON.stringify(path.join(dirname, 'download-node.mjs'))}`);

// 5. Prepare package
step('Preparing package...');
run(`node ${JSON.stringify(path.join(dirname, 'prepare-package.mjs'))}`);

// 6. Package
step('Packaging with @electron/packager...');
run(`node ${JSON.stringify(path.join(dirname, 'package-app.mjs'))}`);

if (!appOnly) {
  // 7. Distributables
  step('Creating distributables (DMG + zip)...');
  run(`node ${JSON.stringify(path.join(dirname, 'make-distributables.mjs'))}`);

  const makeDir = path.join(familiarDir, 'out/make');
  const files = fs.existsSync(makeDir)
    ? fs.readdirSync(makeDir).filter(f => !f.startsWith('.'))
    : [];
  console.log('');
  console.log('Build complete. Distributables:');
  for (const f of files) {
    console.log(`  out/make/${f}`);
  }
} else {
  console.log('');
  console.log('Build complete. Output in packages/familiar/out/');
}
