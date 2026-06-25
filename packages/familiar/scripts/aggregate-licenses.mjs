/**
 * Aggregates third-party LICENSE files for packages shipped inside the
 * Familiar distributable, producing `bundles/LICENSE.third-party.txt`.
 *
 * Coverage:
 *
 * 1. Every input file recorded in `bundles/.metafiles/*.json`
 *    (emitted by `bundle.mjs`) is mapped to its owning package by
 *    walking up to the nearest `package.json`. This captures the Node
 *    side: CLI, daemon, worker, lal-setup, agent, electron-main.
 *
 * 2. The transitive production dependency tree of `@endo/chat` is
 *    walked from `repoRoot/packages/chat/package.json`, since the
 *    chat dist is bundled by Vite (which is not metafiled here). The
 *    walker follows `dependencies` only; `devDependencies` are
 *    excluded because they are not present in the released app.
 *
 * Packages whose `name` starts with `@endo/` are excluded from the
 * third-party file because the surrounding repo's top-level LICENSE
 * already covers them. They are still verified to have a LICENSE file
 * locally; missing files there indicate a bug in our own repo.
 *
 * Usage:
 *   node scripts/aggregate-licenses.mjs            # write the file
 *   node scripts/aggregate-licenses.mjs --verify   # write + fail on gaps
 *   node scripts/aggregate-licenses.mjs --verify-only  # verify only;
 *                                                  # no write
 *
 * Exit status:
 *   0   success (or verify with no gaps)
 *   1   missing LICENSE files for one or more production dependencies
 *   2   metafiles not found (bundle step must run first)
 */

/* global process */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarRoot = path.resolve(dirname, '..');
const repoRoot = path.resolve(familiarRoot, '../..');
const metafileDir = path.join(familiarRoot, 'bundles/.metafiles');
const outFile = path.join(familiarRoot, 'bundles/LICENSE.third-party.txt');

const args = new Set(process.argv.slice(2));
const verify = args.has('--verify') || args.has('--verify-only');
const writeFile = !args.has('--verify-only');

/**
 * Candidate LICENSE filenames in priority order. Many packages use
 * `LICENSE`; a long tail uses other casings and spellings.
 */
const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'License',
  'License.md',
  'license',
  'license.md',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'NOTICE',
  'NOTICE.txt',
];

/**
 * Walks up from `start` looking for the nearest `package.json`. Stops
 * at the filesystem root or when leaving the repo (returns null in
 * that case).
 *
 * @param {string} start - Absolute file path inside a package.
 * @returns {string | null} Absolute path to package.json, or null.
 */
const findNearestPackageJson = start => {
  let dir = path.dirname(path.resolve(start));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      // Skip per-file or per-export `package.json` shims that just
      // set `"type": "module"` or `"type": "commonjs"` without `name`.
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data.name) return candidate;
      } catch {
        // Malformed package.json; keep walking.
      }
    }
    dir = path.dirname(dir);
  }
  return null;
};

/**
 * Locates a LICENSE file inside `pkgDir`. Returns the absolute path
 * to the first match by priority, or null if none found.
 *
 * @param {string} pkgDir
 * @returns {string | null}
 */
const findLicenseFile = pkgDir => {
  for (const name of LICENSE_FILENAMES) {
    const candidate = path.join(pkgDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
};

/**
 * Reads a package.json and returns a small record. Throws if the
 * file is unreadable; the caller decides whether that is fatal.
 *
 * @param {string} packageJsonPath
 */
const readPackageRecord = packageJsonPath => {
  const data = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const pkgDir = path.dirname(packageJsonPath);
  let repositoryUrl = '';
  if (typeof data.repository === 'string') {
    repositoryUrl = data.repository;
  } else if (data.repository && typeof data.repository.url === 'string') {
    repositoryUrl = data.repository.url;
  }
  return {
    name: /** @type {string} */ (data.name),
    version: /** @type {string} */ (data.version || '0.0.0'),
    license:
      typeof data.license === 'string'
        ? data.license
        : data.license && data.license.type
          ? data.license.type
          : 'UNKNOWN',
    repositoryUrl,
    pkgDir,
    dependencies: /** @type {Record<string,string>} */ (
      data.dependencies || {}
    ),
    // peerDependencies are not auto-installed but are present at
    // runtime when the consumer declares them; we include them in
    // the walk to be safe.
    peerDependencies: /** @type {Record<string,string>} */ (
      data.peerDependencies || {}
    ),
  };
};

/**
 * Map keyed by `name@version` of unique third-party packages
 * discovered. Value is the package record plus an optional
 * `licenseFile` path.
 *
 * @type {Map<string, ReturnType<typeof readPackageRecord> & {
 *   licenseFile: string | null,
 * }>}
 */
const discovered = new Map();

/**
 * Adds a package to the discovered map (deduping by name@version).
 *
 * @param {ReturnType<typeof readPackageRecord>} record
 */
const recordPackage = record => {
  const key = `${record.name}@${record.version}`;
  if (discovered.has(key)) return;
  discovered.set(key, {
    ...record,
    licenseFile: findLicenseFile(record.pkgDir),
  });
};

// -----------------------------------------------------------------
// Source 1: esbuild metafiles
// -----------------------------------------------------------------

if (!fs.existsSync(metafileDir)) {
  console.error(`Metafile directory not found: ${metafileDir}`);
  console.error('Run scripts/bundle.mjs first.');
  process.exit(2);
}

const metafiles = fs.readdirSync(metafileDir).filter(f => f.endsWith('.json'));

if (metafiles.length === 0) {
  console.error(`No metafiles in ${metafileDir}.`);
  console.error('Run scripts/bundle.mjs first.');
  process.exit(2);
}

for (const meta of metafiles) {
  const metafileContents = JSON.parse(
    fs.readFileSync(path.join(metafileDir, meta), 'utf8'),
  );
  for (const inputPath of Object.keys(metafileContents.inputs || {})) {
    // esbuild reports inputs as repo-relative paths.
    const absolute = path.resolve(repoRoot, inputPath);
    const pkgJson = findNearestPackageJson(absolute);
    if (pkgJson) {
      try {
        recordPackage(readPackageRecord(pkgJson));
      } catch (e) {
        console.warn(
          `Skipping malformed package.json at ${pkgJson}: ${
            /** @type {Error} */ (e).message
          }`,
        );
      }
    }
  }
}

// -----------------------------------------------------------------
// Source 2: production dependency tree of @endo/chat
// -----------------------------------------------------------------

/**
 * Resolves a package's `package.json` from the perspective of a
 * starting directory using Node's resolution algorithm.
 *
 * @param {string} fromDir - The directory whose `node_modules` chain
 *   we resolve against.
 * @param {string} name - Package name (e.g. `react`, `@scope/pkg`).
 * @returns {string | null} Absolute path to the resolved
 *   `package.json`, or null if resolution fails.
 */
const resolvePackageJson = (fromDir, name) => {
  const req = createRequire(path.join(fromDir, 'package.json'));
  try {
    return req.resolve(`${name}/package.json`);
  } catch {
    // Some packages (e.g. those with restrictive `exports`) refuse
    // to resolve `package.json`. Fall back to a manual walk.
    let dir = fromDir;
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name, 'package.json');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    return null;
  }
};

const chatPackageJson = path.join(repoRoot, 'packages/chat/package.json');
if (fs.existsSync(chatPackageJson)) {
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Array<{ packageJsonPath: string }>} */
  const queue = [{ packageJsonPath: chatPackageJson }];
  while (queue.length > 0) {
    const { packageJsonPath } = /** @type {{ packageJsonPath: string }} */ (
      queue.shift()
    );
    if (!visited.has(packageJsonPath)) {
      visited.add(packageJsonPath);
      /** @type {ReturnType<typeof readPackageRecord> | null} */
      let record = null;
      try {
        record = readPackageRecord(packageJsonPath);
      } catch {
        // Malformed package.json; skip without recording or recursing.
      }
      if (record) {
        // The chat package itself is first-party; we only seed its
        // dependency walk. Do not record it as a third-party entry.
        if (packageJsonPath !== chatPackageJson) {
          recordPackage(record);
        }
        const fromDir = path.dirname(packageJsonPath);
        const allDeps = {
          ...record.dependencies,
          ...record.peerDependencies,
        };
        for (const depName of Object.keys(allDeps)) {
          const resolved = resolvePackageJson(fromDir, depName);
          if (resolved && !visited.has(resolved)) {
            queue.push({ packageJsonPath: resolved });
          }
        }
      }
    }
  }
} else {
  console.warn(
    `aggregate-licenses: @endo/chat package.json not found at ` +
      `${chatPackageJson}; chat-tree coverage skipped.`,
  );
}

// -----------------------------------------------------------------
// Partition first-party (@endo/*) from third-party
// -----------------------------------------------------------------

/** @type {Array<typeof discovered extends Map<any, infer V> ? V : never>} */
const firstParty = [];
/** @type {Array<typeof discovered extends Map<any, infer V> ? V : never>} */
const thirdParty = [];

for (const record of discovered.values()) {
  if (record.name.startsWith('@endo/')) {
    firstParty.push(record);
  } else {
    thirdParty.push(record);
  }
}

const byName = (a, b) =>
  a.name === b.name
    ? a.version.localeCompare(b.version)
    : a.name.localeCompare(b.name);
firstParty.sort(byName);
thirdParty.sort(byName);

// -----------------------------------------------------------------
// Verification.
//
// A production dep has acceptable attribution when either:
//
//   1. A LICENSE-like file ships inside its package directory
//      (the normal case), OR
//
//   2. Its package.json declares a non-empty `license` field
//      identifying the SPDX expression. In this case the package
//      omitted the LICENSE text from its tarball (a common pattern
//      in the libp2p / multiformats ecosystems) but the
//      attribution metadata is still authoritative. We surface the
//      SPDX expression and the repository URL in the aggregated
//      file so the reader can verify upstream.
//
// A package fails verification when both are absent: no LICENSE
// file and no declared license. That is the actionable gap.
// -----------------------------------------------------------------

/**
 * Classifies a discovered record. Returns `'file'`, `'spdx'`, or
 * `'missing'`.
 *
 * @param {{ licenseFile: string | null, license: string }} record
 */
const classifyRecord = record => {
  if (record.licenseFile) return 'file';
  if (record.license && record.license !== 'UNKNOWN') return 'spdx';
  return 'missing';
};

const spdxOnly = thirdParty.filter(r => classifyRecord(r) === 'spdx');
const gaps = thirdParty.filter(r => classifyRecord(r) === 'missing');
const firstPartyGaps = firstParty.filter(r => classifyRecord(r) === 'missing');

if (spdxOnly.length > 0) {
  console.warn(
    `Note: ${spdxOnly.length} third-party package(s) ship without a` +
      ` LICENSE file but declare an SPDX expression in package.json.` +
      ` The aggregated file records the SPDX id and repository URL` +
      ` for these packages.`,
  );
}

if (firstPartyGaps.length > 0) {
  console.warn(
    `First-party @endo packages with neither LICENSE file nor declared` +
      ` license (in-repo bug):`,
  );
  for (const g of firstPartyGaps) {
    console.warn(`  ${g.name}@${g.version} at ${g.pkgDir}`);
  }
}

if (gaps.length > 0) {
  console.error(
    `\nFound ${gaps.length} third-party production dep(s) with no` +
      ` LICENSE file and no declared license:`,
  );
  for (const g of gaps) {
    console.error(`  ${g.name}@${g.version} at ${g.pkgDir}`);
  }
}

// -----------------------------------------------------------------
// Emit
// -----------------------------------------------------------------

if (writeFile) {
  const header = [
    'THIRD-PARTY SOFTWARE NOTICES AND INFORMATION',
    '',
    'The Familiar application incorporates the following third-party',
    'open source software. This file is auto-generated by',
    'scripts/aggregate-licenses.mjs from the bundled esbuild metafiles',
    'and the @endo/chat production dependency tree.',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total third-party packages: ${thirdParty.length}`,
    '',
    '='.repeat(72),
    '',
  ].join('\n');

  const sections = thirdParty.map(record => {
    const headingLines = [
      `Package: ${record.name}`,
      `Version: ${record.version}`,
      `License: ${record.license}`,
    ];
    if (record.repositoryUrl) {
      headingLines.push(`Repository: ${record.repositoryUrl}`);
    }
    const heading = headingLines.join('\n');
    let body;
    if (record.licenseFile) {
      body = fs.readFileSync(record.licenseFile, 'utf8').trimEnd();
    } else if (record.license && record.license !== 'UNKNOWN') {
      body =
        `This package does not ship a LICENSE file. Its package.json` +
        ` declares the license as "${record.license}". Refer to the` +
        ` repository above for the full license text.`;
    } else {
      body =
        `(No LICENSE file shipped and no declared license. This is a` +
        ` gap that should be reported upstream.)`;
    }
    return `${heading}\n\n${body}\n\n${'-'.repeat(72)}\n`;
  });

  const content = header + sections.join('\n');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, content);
  console.log(
    `Wrote ${outFile} (${thirdParty.length} third-party packages, ` +
      `${firstParty.length} first-party @endo packages omitted).`,
  );
}

if (verify && gaps.length > 0) {
  process.exit(1);
}
