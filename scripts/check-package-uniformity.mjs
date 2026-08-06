#!/usr/bin/env zx
// @ts-check

/**
 * @file Enforce uniformity of metadata files across every workspace
 * package using packages/skel/ as the template.
 *
 * The checks (all fail closed; non-zero exit on any drift):
 *
 *   1. SECURITY.md is byte-identical to packages/skel/SECURITY.md.
 *   2. LICENSE matches packages/skel/LICENSE modulo the copyright line.
 *      The copyright line must match either the skel placeholder
 *      "Copyright [yyyy] [name of copyright owner]" or the filled form
 *      "Copyright <YYYY> Endo Contributors". This preserves the existing
 *      scripts/set-license-text.sh convention of stamping the package's
 *      creation year into its LICENSE.
 *   3. package.json fields:
 *      - author              matches skel
 *      - license             matches skel
 *      - type                matches skel
 *      - repository.type     matches skel
 *      - repository.url      matches skel
 *      - repository.directory == "packages/<dir>"
 *      - name                ends with "/<dir>" (after the `@endo` scope)
 *                            or equals "<dir>" for unscoped historical names
 *      - bugs.url            matches skel
 *      - publishConfig.access == "public" (only for packages whose
 *                                          private flag is not true)
 *      - description         is non-empty AND not equal to skel's
 *                            description (skel itself is exempt; skel's
 *                            null value is the placeholder this check
 *                            forbids elsewhere)
 *      - TypeScript declaration entry targets are present in npm's actual
 *        pack list (only for packages whose private flag is not true)
 *      - Every literal TypeScript declaration entry target exists in the
 *        package tree, or is derivable by declaration emit from a sibling
 *        source file (all packages, private included)
 *   4. Every tracked declaration file follows the *.types.d.* naming
 *      convention or has an explicit negation in the root .gitignore.
 *
 * The skel package is the source of truth and is exempt from the
 * description differs-from-skel check (since skel defines the default
 * the check forbids).
 *
 * This is the JavaScript port of the original scripts/check-package-uniformity.sh
 * (zx-flavored per the workspace's preference for JS over shell for new
 * enforcement scripts).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import packlist from 'npm-packlist';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const SKEL_REL = 'packages/skel';
const SKEL_ABS = path.join(repoRoot, SKEL_REL);

let exitCode = 0;

/**
 * Report a finding and mark exit non-zero. The message shape mirrors the
 * original shell script: "<pkg>: <what differs>".
 *
 * @param {string} message
 */
const fail = message => {
  console.log(message);
  exitCode = 1;
};

/**
 * @param {string} absPath
 * @returns {Promise<string>}
 */
const sha256OfFile = async absPath => {
  const buf = await readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
};

/**
 * sha256 of LICENSE body with the canonical copyright line stripped.
 * The shell script does `grep -v '^   Copyright ' LICENSE | sha256sum`.
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
const sha256OfLicenseModuloCopyright = async absPath => {
  const text = await readFile(absPath, 'utf8');
  const lines = text.split('\n');
  const filtered = lines.filter(line => !line.startsWith('   Copyright '));
  return createHash('sha256').update(filtered.join('\n')).digest('hex');
};

/**
 * Extract a value at a dotted path from a parsed object, returning '' for any
 * missing intermediate or final value. Mirrors `jq -r '<path> // ""'`.
 *
 * @param {unknown} obj
 * @param {string} dottedPath e.g. ".repository.url"
 * @returns {string}
 */
const fieldAt = (obj, dottedPath) => {
  const parts = dottedPath.replace(/^\./, '').split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return '';
    cursor = /** @type {Record<string, unknown>} */ (cursor)[part];
  }
  if (cursor == null) return '';
  return String(cursor);
};

/**
 * Known historical exceptions: <pkg>:<jq-path>:<allowed-value>.
 *
 * Each entry permits one specific package.json field to deviate from the
 * skel value for a documented reason. Keep this list small and named;
 * every entry needs a comment explaining why.
 */
const EXCEPTIONS = [
  // eslint-plugin is a CommonJS plugin for ESLint v8 (it consumes
  // requireindex and uses __dirname / module.exports). Migrating it
  // to ESM is a substantial refactor; until that lands, the package
  // legitimately ships without a 'type' field (effectively commonjs).
  'packages/eslint-plugin:.type:',
];

/**
 * @param {string} pkg
 * @param {string} path
 * @param {string} actual
 */
const isException = (pkg, path, actual) =>
  EXCEPTIONS.includes(`${pkg}:${path}:${actual}`);

const DECLARATION_FILE_RE = /\.d\.(?:ts|mts|cts)$/u;
const CONVENTIONAL_DECLARATION_FILE_RE = /\.types\.d\.(?:ts|mts|cts)$/u;

/**
 * Ensure a hand-authored declaration cannot be tracked only through
 * `git add --force` while remaining subject to the root declaration ignore
 * rule. Such files can be omitted by npm-packlist, and their publication can
 * otherwise depend on package-specific `files` rules. The naming convention
 * or an explicit exception makes the tracking intent visible.
 */
const assertTrackedDeclarationFileNames = async () => {
  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  const explicitlyUnignored = new Set(
    gitignore
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('!'))
      .map(line => line.slice(1).replace(/^\//u, '')),
  );
  const trackedFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.d.ts', '*.d.mts', '*.d.cts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean);

  for (const relPath of trackedFiles) {
    if (!DECLARATION_FILE_RE.test(relPath)) continue;
    if (CONVENTIONAL_DECLARATION_FILE_RE.test(relPath)) continue;
    if (explicitlyUnignored.has(relPath)) continue;
    fail(
      `${relPath}: tracked declaration must follow the '*.types.d.{ts,mts,cts}' convention or have an explicit root .gitignore negation`,
    );
  }
};

/**
 * @param {string} pkg
 * @param {object} json parsed package.json
 * @param {string} path dotted jq-style path
 * @param {string} expected expected value (as a string; '' for absent)
 */
const assertField = (pkg, json, path, expected) => {
  const actual = fieldAt(json, path);
  if (actual !== expected) {
    if (isException(pkg, path, actual)) return;
    fail(
      `${pkg}: package.json ${path} expected '${expected}' actual '${actual}'`,
    );
  }
};

/**
 * @typedef {object} DeclarationTarget
 * @property {string} metadataPath
 * @property {string} target
 * @property {'exports' | 'top-level' | 'typesVersions'} source
 * @property {boolean} substitutesStar
 */

/**
 * @param {string} base
 * @param {string} key
 * @returns {string}
 */
const metadataProperty = (base, key) => `${base}[${JSON.stringify(key)}]`;

/**
 * TypeScript recognizes `types` plus versioned `types@<selector>` export
 * conditions. `typings` is accepted conservatively for parity with the
 * top-level alias. Selectors do not need to be interpreted here: checking
 * every version branch is both simpler and stronger than checking only the
 * branch selected by the TypeScript version running this script.
 *
 * @param {string} condition
 * @returns {boolean}
 */
const isDeclarationCondition = condition =>
  condition === 'types' ||
  condition === 'typings' ||
  condition.startsWith('types@');

/**
 * Collect every string leaf below a declaration condition. Export target
 * arrays and nested condition objects are both valid, and every branch can be
 * selected by some consumer. `null` deliberately disables a branch and does
 * not name a file.
 *
 * @param {unknown} value
 * @param {string} metadataPath
 * @param {string} subpath
 * @param {DeclarationTarget[]} targets
 * @param {string[]} problems
 */
const collectDeclarationConditionTargets = (
  value,
  metadataPath,
  subpath,
  targets,
  problems,
) => {
  if (typeof value === 'string') {
    targets.push({
      metadataPath,
      target: value,
      source: 'exports',
      substitutesStar: subpath.includes('*') && value.includes('*'),
    });
    return;
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectDeclarationConditionTargets(
        item,
        `${metadataPath}[${index}]`,
        subpath,
        targets,
        problems,
      ),
    );
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectDeclarationConditionTargets(
        child,
        metadataProperty(metadataPath, key),
        subpath,
        targets,
        problems,
      );
    }
    return;
  }
  problems.push(
    `${metadataPath} has unsupported ${typeof value} declaration target`,
  );
};

/**
 * Find declaration conditions without confusing subpath maps with condition
 * maps. Mixing keys that start with `.` and condition keys is invalid under
 * Node package-export semantics, so reject that shape instead of guessing.
 *
 * @param {unknown} value
 * @param {string} metadataPath
 * @param {string} subpath
 * @param {DeclarationTarget[]} targets
 * @param {string[]} problems
 */
const collectExportsDeclarationTargets = (
  value,
  metadataPath,
  subpath,
  targets,
  problems,
) => {
  if (value === null || typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectExportsDeclarationTargets(
        item,
        `${metadataPath}[${index}]`,
        subpath,
        targets,
        problems,
      ),
    );
    return;
  }
  if (typeof value !== 'object') {
    problems.push(`${metadataPath} has unsupported ${typeof value} target`);
    return;
  }

  const entries = Object.entries(value);
  const hasSubpaths = entries.some(([key]) => key.startsWith('.'));
  const hasConditions = entries.some(([key]) => !key.startsWith('.'));
  if (hasSubpaths && hasConditions) {
    problems.push(
      `${metadataPath} mixes export subpaths and conditions, which Node rejects`,
    );
    return;
  }

  for (const [key, child] of entries) {
    const childPath = metadataProperty(metadataPath, key);
    if (hasSubpaths) {
      collectExportsDeclarationTargets(
        child,
        childPath,
        key,
        targets,
        problems,
      );
    } else if (isDeclarationCondition(key)) {
      collectDeclarationConditionTargets(
        child,
        childPath,
        subpath,
        targets,
        problems,
      );
    } else {
      collectExportsDeclarationTargets(
        child,
        childPath,
        subpath,
        targets,
        problems,
      );
    }
  }
};

/**
 * `typesVersions` path substitutions are checked across every version range,
 * not merely the first range matching the local compiler. The common
 * `"*": ["ts5/*"]` tree form is supported. A substitution with more than
 * one `*` is rejected explicitly because TypeScript replaces only its first
 * star; treating it as a Node export pattern would silently overstate
 * coverage.
 *
 * @param {unknown} typesVersions
 * @param {DeclarationTarget[]} targets
 * @param {string[]} problems
 */
const collectTypesVersionsTargets = (typesVersions, targets, problems) => {
  if (
    typesVersions === null ||
    typeof typesVersions !== 'object' ||
    Array.isArray(typesVersions)
  ) {
    problems.push('package.json["typesVersions"] must be an object');
    return;
  }

  for (const [selector, mappings] of Object.entries(typesVersions)) {
    const selectorPath = metadataProperty(
      'package.json["typesVersions"]',
      selector,
    );
    if (
      mappings === null ||
      typeof mappings !== 'object' ||
      Array.isArray(mappings)
    ) {
      problems.push(`${selectorPath} must be an object of path mappings`);
      continue;
    }
    for (const [specifier, substitutions] of Object.entries(mappings)) {
      const mappingPath = metadataProperty(selectorPath, specifier);
      if (!Array.isArray(substitutions)) {
        problems.push(`${mappingPath} must be an array of substitutions`);
        continue;
      }
      substitutions.forEach((target, index) => {
        const targetPath = `${mappingPath}[${index}]`;
        if (typeof target !== 'string') {
          problems.push(`${targetPath} must be a string`);
          return;
        }
        const stars = target.match(/\*/g)?.length || 0;
        if (stars > 1) {
          problems.push(
            `${targetPath} target '${target}' has multiple stars; only single-star typesVersions substitutions are supported`,
          );
          return;
        }
        targets.push({
          metadataPath: targetPath,
          target,
          source: 'typesVersions',
          substitutesStar: specifier.includes('*') && stars === 1,
        });
      });
    }
  }
};

/**
 * @param {Record<string, unknown>} packageJson
 * @returns {{targets: DeclarationTarget[], problems: string[]}}
 */
const collectDeclarationTargets = packageJson => {
  /** @type {DeclarationTarget[]} */
  const targets = [];
  /** @type {string[]} */
  const problems = [];

  for (const field of ['types', 'typings']) {
    const value = packageJson[field];
    if (value == null) continue;
    const metadataPath = `package.json[${JSON.stringify(field)}]`;
    if (typeof value !== 'string') {
      problems.push(`${metadataPath} must be a string`);
      continue;
    }
    targets.push({
      metadataPath,
      target: value,
      source: 'top-level',
      substitutesStar: false,
    });
  }

  if (packageJson.exports !== undefined) {
    collectExportsDeclarationTargets(
      packageJson.exports,
      'package.json["exports"]',
      '.',
      targets,
      problems,
    );
  }
  if (packageJson.typesVersions !== undefined) {
    collectTypesVersionsTargets(packageJson.typesVersions, targets, problems);
  }
  return { targets, problems };
};

/**
 * @param {string} target
 * @returns {string | undefined}
 */
const normalizePackageTarget = target => {
  if (target.includes('\\') || target.includes('?') || target.includes('#')) {
    return undefined;
  }
  const stripped = target.replace(/^\.\//, '');
  const normalized = path.posix.normalize(stripped);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
};

/**
 * Normalize paths returned by npm-packlist before comparing them with
 * package-relative declaration targets.
 *
 * npm-packlist can prefix paths under a scoped directory with `./`.
 * `normalizePackageTarget` also strips that prefix from literal and pattern
 * targets, so use it for both sides of every publication comparison.
 *
 * @param {string[]} files
 * @returns {Set<string>}
 */
const normalizePacklistFiles = files =>
  new Set(files.map(normalizePackageTarget).filter(file => file !== undefined));

/**
 * Enumerate source-tree files for export-pattern expansion. This is separate
 * from npm packing on purpose: candidates come from the package tree, while
 * publication is decided solely by npm-packlist. `node_modules` cannot occur
 * in an export target or pattern substitution and is skipped without walking.
 *
 * @param {string} packageDir
 * @param {string} [relativeDir]
 * @returns {Promise<string[]>}
 */
const listPackageTreeFiles = async (packageDir, relativeDir = '') => {
  /** @type {string[]} */
  const files = [];
  const entries = await readdir(path.join(packageDir, relativeDir), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const relativePath = relativeDir
      ? path.posix.join(relativeDir, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listPackageTreeFiles(packageDir, relativePath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativePath);
    }
  }
  return files;
};

/**
 * Ask npm-packlist whether declaration files that are generated only during
 * packing would be included once materialized. The small synthetic tree uses
 * the real manifest and copies every ancestor `.npmignore`/`.gitignore`, so
 * npm's own ignore-walk remains authoritative. Existing files use the actual
 * package tree instead.
 *
 * @param {string} packageDir
 * @param {Record<string, unknown>} packageJson
 * @param {string[]} placeholders
 * @returns {Promise<Set<string>>}
 */
const listGeneratedDeclarationPackFiles = async (
  packageDir,
  packageJson,
  placeholders,
) => {
  const syntheticDir = await mkdtemp(
    path.join(tmpdir(), 'endo-packlist-check-'),
  );
  try {
    await writeFile(
      path.join(syntheticDir, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    /** @type {Set<string>} */
    const directories = new Set(['']);
    for (const placeholder of placeholders) {
      const directory = path.posix.dirname(placeholder);
      for (
        let ancestor = directory;
        ancestor !== '.';
        ancestor = path.posix.dirname(ancestor)
      ) {
        directories.add(ancestor);
      }
      const destination = path.join(syntheticDir, placeholder);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, '');
    }
    for (const directory of directories) {
      for (const ignoreName of ['.npmignore', '.gitignore']) {
        try {
          const ignore = await readFile(
            path.join(packageDir, directory, ignoreName),
            'utf8',
          );
          const destination = path.join(syntheticDir, directory, ignoreName);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, ignore);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
            throw error;
          }
        }
      }
    }
    return normalizePacklistFiles(
      await packlist({
        path: syntheticDir,
        package: packageJson,
        isProjectRoot: true,
      }),
    );
  } finally {
    await rm(syntheticDir, { recursive: true, force: true });
  }
};

/**
 * Node export patterns use literal string substitution: one captured value,
 * which may contain `/`, replaces every `*` in the target. This deliberately
 * does not implement or reuse npm `files` glob semantics.
 *
 * @param {string} target
 * @returns {(candidate: string) => boolean}
 */
const makeExportSubstitutionMatcher = target => {
  const parts = target.split('*');
  const escape = part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  let source = escape(parts[0]);
  for (const [index, part] of parts.slice(1).entries()) {
    source += `${index === 0 ? '(?<subpath>.+)' : '\\k<subpath>'}${escape(part)}`;
  }
  const expression = new RegExp(`^${source}$`);
  return candidate => expression.test(candidate);
};

const DECLARATION_SOURCE = /(?:\.d\.(?:ts|cts|mts)|\.(?:ts|tsx|cts|mts))$/;

/**
 * @param {string} packageDir
 * @param {string} relativePath
 * @returns {Promise<boolean>}
 */
const pathExists = async (packageDir, relativePath) => {
  try {
    await stat(path.join(packageDir, relativePath));
    return true;
  } catch {
    return false;
  }
};

/**
 * Sibling source paths that declaration emit could produce `target` from, or
 * `[]` if `target` does not have a declaration-file extension declaration
 * emit recognizes.
 *
 * @param {string} target normalized (package-relative, `./`-stripped) target
 * @returns {string[]}
 */
const declarationEmitSources = target => {
  if (target.endsWith('.d.mts')) {
    const base = target.slice(0, -'.d.mts'.length);
    return [`${base}.mts`, `${base}.mjs`];
  }
  if (target.endsWith('.d.cts')) {
    const base = target.slice(0, -'.d.cts'.length);
    return [`${base}.cts`, `${base}.cjs`];
  }
  if (target.endsWith('.d.ts')) {
    const base = target.slice(0, -'.d.ts'.length);
    return [`${base}.ts`, `${base}.tsx`, `${base}.js`];
  }
  return [];
};

/**
 * Known historical exceptions to declaration-emit derivability:
 * `<pkg>:<normalized-target>`.
 *
 * Each entry documents one target that a package legitimately generates by
 * some means other than same-directory declaration emit. Keep this list
 * small and named; every entry needs a comment explaining why.
 */
const DECLARATION_TARGET_EXCEPTIONS = [
  // packages/ses builds its CJS declaration file by copying the ESM
  // ./types.d.ts to ./dist/types.d.cts at bundle time
  // (packages/ses-test/scripts/bundle.js's `sourceDTS`/`destDTS` copy), not
  // by compiling a same-named ./dist/types.cts or ./dist/types.cjs source.
  // Declaration-emit derivability does not model a cross-directory copy.
  'packages/ses:dist/types.d.cts',
];

/**
 * @param {string} pkg
 * @param {string} normalizedTarget
 * @returns {boolean}
 */
const isExemptDeclarationTarget = (pkg, normalizedTarget) =>
  DECLARATION_TARGET_EXCEPTIONS.includes(`${pkg}:${normalizedTarget}`);

/**
 * A missing literal target is derivable when its name matches a declaration
 * emit output (`<base>.d.ts`/`.d.mts`/`.d.cts`) and a sibling generator
 * source for that output exists in the package tree. A dangling target with
 * no generator sibling is out of scope for placeholder materialization: no
 * build step will ever produce it, so treating it as covered would hide a
 * typo or a stale path.
 *
 * @param {string} packageDir
 * @param {string} normalizedTarget
 * @returns {Promise<boolean>}
 */
const isDerivableDeclarationTarget = async (packageDir, normalizedTarget) => {
  const candidates = declarationEmitSources(normalizedTarget);
  for (const candidate of candidates) {
    if (await pathExists(packageDir, candidate)) return true;
  }
  return false;
};

/**
 * Every literal declaration target (excluding tree-substitution patterns,
 * which are only reported when a pattern resolves to a file that exists)
 * must either exist in the package tree or be derivable by declaration emit.
 * This runs for every package, private included: a dangling target is a
 * defect in the source tree regardless of whether the package is ever
 * published, unlike the packlist-omission leg below.
 *
 * @param {string} packageDir absolute or relative package directory
 * @param {Record<string, unknown>} packageJson parsed package.json
 * @param {string} packageLabel path/name used in findings
 * @returns {Promise<string[]>}
 */
export const findDeclarationExistenceProblems = async (
  packageDir,
  packageJson,
  packageLabel,
) => {
  const { targets } = collectDeclarationTargets(packageJson);
  /** @type {string[]} */
  const problems = [];
  for (const target of targets) {
    if (target.substitutesStar) continue;
    const normalizedTarget = normalizePackageTarget(target.target);
    if (normalizedTarget === undefined) continue;
    if (await pathExists(packageDir, normalizedTarget)) continue;
    if (await isDerivableDeclarationTarget(packageDir, normalizedTarget)) {
      continue;
    }
    if (isExemptDeclarationTarget(packageLabel, normalizedTarget)) continue;
    problems.push(
      `${packageLabel}: ${target.metadataPath} target '${target.target}' does not exist and has no declaration-emit source to derive it from`,
    );
  }
  return problems;
};

/**
 * Compare TypeScript declaration entry targets with the authoritative file
 * list used by npm packing. Pattern targets are expanded over the source tree
 * using Node/TypeScript substitution semantics, then every materialized path
 * must occur in npm-packlist. This catches a nested export substitution that a
 * shallow npm `files` glob omits without attempting to emulate npm globs.
 *
 * The checker deliberately fails closed on target URLs with query/fragment
 * suffixes and on multi-star `typesVersions` substitutions. Those uncommon
 * valid shapes need TypeScript's full resolver and must not be silently
 * treated as covered.
 *
 * @param {string} packageDir absolute or relative package directory
 * @param {Record<string, unknown>} packageJson parsed package.json
 * @param {string} packageLabel path/name used in findings
 * @returns {Promise<string[]>}
 */
export const findDeclarationPublicationProblems = async (
  packageDir,
  packageJson,
  packageLabel,
) => {
  if (packageJson.private === true) return [];

  const { targets, problems: metadataProblems } =
    collectDeclarationTargets(packageJson);
  if (targets.length === 0 && metadataProblems.length === 0) return [];

  /** @type {string[]} */
  const problems = metadataProblems.map(
    problem => `${packageLabel}: ${problem}`,
  );
  const packedFiles = normalizePacklistFiles(
    await packlist({
      path: packageDir,
      package: packageJson,
      isProjectRoot: true,
    }),
  );
  const literalTargets = targets
    .filter(({ substitutesStar }) => !substitutesStar)
    .map(({ target }) => normalizePackageTarget(target))
    .filter(target => target !== undefined);
  const missingLiteralTargets = literalTargets.filter(
    target => !packedFiles.has(target),
  );
  /** @type {string[]} */
  const derivableMissingTargets = [];
  for (const target of missingLiteralTargets) {
    if (
      (await isDerivableDeclarationTarget(packageDir, target)) ||
      isExemptDeclarationTarget(packageLabel, target)
    ) {
      derivableMissingTargets.push(target);
    }
  }
  const generatedPackedFiles =
    derivableMissingTargets.length > 0
      ? await listGeneratedDeclarationPackFiles(
          packageDir,
          packageJson,
          derivableMissingTargets,
        )
      : new Set();
  const needsTree = targets.some(({ substitutesStar }) => substitutesStar);
  const treeFiles = needsTree ? await listPackageTreeFiles(packageDir) : [];

  for (const target of targets) {
    const normalizedTarget = normalizePackageTarget(target.target);
    if (normalizedTarget === undefined) {
      problems.push(
        `${packageLabel}: ${target.metadataPath} target '${target.target}' is not a supported package-relative file target`,
      );
      continue;
    }

    if (!target.substitutesStar) {
      if (
        target.source === 'typesVersions' &&
        !DECLARATION_SOURCE.test(normalizedTarget)
      ) {
        problems.push(
          `${packageLabel}: ${target.metadataPath} target '${target.target}' uses TypeScript extension or directory resolution; only declaration-file and single-star tree substitutions are supported`,
        );
      } else if (
        !packedFiles.has(normalizedTarget) &&
        !generatedPackedFiles.has(normalizedTarget)
      ) {
        problems.push(
          `${packageLabel}: ${target.metadataPath} target '${target.target}' is not included in the npm pack list`,
        );
      }
      continue;
    }

    const matches = makeExportSubstitutionMatcher(normalizedTarget);
    let candidates = treeFiles.filter(matches);
    if (target.source === 'typesVersions') {
      candidates = candidates.filter(candidate =>
        DECLARATION_SOURCE.test(candidate),
      );
    }
    if (candidates.length === 0) {
      problems.push(
        `${packageLabel}: ${target.metadataPath} target pattern '${target.target}' matches no declaration file in the package tree`,
      );
      continue;
    }
    for (const candidate of candidates.sort()) {
      if (!packedFiles.has(candidate)) {
        problems.push(
          `${packageLabel}: ${target.metadataPath} target pattern '${target.target}' resolves to '${candidate}', which is not included in the npm pack list`,
        );
      }
    }
  }
  return problems;
};

const main = async () => {
  await assertTrackedDeclarationFileNames();

  // Source-of-truth values harvested from skel once.
  const skelSecuritySha = await sha256OfFile(
    path.join(SKEL_ABS, 'SECURITY.md'),
  );
  const skelLicenseNoCopy = await sha256OfLicenseModuloCopyright(
    path.join(SKEL_ABS, 'LICENSE'),
  );
  const skelPackage = JSON.parse(
    await readFile(path.join(SKEL_ABS, 'package.json'), 'utf8'),
  );
  const skelAuthor = fieldAt(skelPackage, '.author');
  const skelLicenseField = fieldAt(skelPackage, '.license');
  const skelType = fieldAt(skelPackage, '.type');
  const skelRepoType = fieldAt(skelPackage, '.repository.type');
  const skelRepoUrl = fieldAt(skelPackage, '.repository.url');
  const skelBugsUrl = fieldAt(skelPackage, '.bugs.url');
  const skelDescription = fieldAt(skelPackage, '.description');

  // Collect every workspace package (every packages/<dir>/package.json),
  // sorted to match the shell script's `find ... | sort` order.
  const packagesDir = path.join(repoRoot, 'packages');
  const dirents = await readdir(packagesDir, { withFileTypes: true });
  /** @type {string[]} */
  const pkgs = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const pkgRel = `packages/${dirent.name}`;
    try {
      await stat(path.join(repoRoot, pkgRel, 'package.json'));
      pkgs.push(pkgRel);
    } catch {
      // No package.json in this directory; skip it (matches the shell
      // script's `find -name 'package.json'` filter).
    }
  }
  pkgs.sort();

  // --- SECURITY.md byte-identical to skel --------------------------------
  for (const pkg of pkgs) {
    const securityPath = path.join(repoRoot, pkg, 'SECURITY.md');
    try {
      await stat(securityPath);
    } catch {
      fail(`${pkg}: missing SECURITY.md`);
      continue;
    }
    const hash = await sha256OfFile(securityPath);
    if (hash !== skelSecuritySha) {
      fail(
        `${pkg}: SECURITY.md differs from ${SKEL_REL}/SECURITY.md (sha256 ${hash} vs ${skelSecuritySha})`,
      );
    }
  }

  // --- LICENSE matches skel modulo the copyright line --------------------
  for (const pkg of pkgs) {
    const licensePath = path.join(repoRoot, pkg, 'LICENSE');
    try {
      await stat(licensePath);
    } catch {
      fail(`${pkg}: missing LICENSE`);
      continue;
    }
    const noCopyHash = await sha256OfLicenseModuloCopyright(licensePath);
    if (noCopyHash !== skelLicenseNoCopy) {
      fail(
        `${pkg}: LICENSE body differs from ${SKEL_REL}/LICENSE (ignoring copyright line)`,
      );
      continue;
    }
    const licenseText = await readFile(licensePath, 'utf8');
    const copyLine =
      licenseText.split('\n').find(line => line.startsWith('   Copyright ')) ||
      '';
    if (
      !/^ {3}Copyright (\[yyyy\] \[name of copyright owner\]|[0-9]{4} Endo Contributors)$/.test(
        copyLine,
      )
    ) {
      fail(`${pkg}: LICENSE copyright line not canonical: ${copyLine}`);
    }
  }

  // --- package.json field uniformity -------------------------------------
  for (const pkg of pkgs) {
    const jsonPath = path.join(repoRoot, pkg, 'package.json');
    const dirName = path.basename(pkg);
    const json = JSON.parse(await readFile(jsonPath, 'utf8'));

    assertField(pkg, json, '.author', skelAuthor);
    assertField(pkg, json, '.license', skelLicenseField);
    assertField(pkg, json, '.type', skelType);
    assertField(pkg, json, '.repository.type', skelRepoType);
    assertField(pkg, json, '.repository.url', skelRepoUrl);
    assertField(pkg, json, '.repository.directory', `packages/${dirName}`);
    assertField(pkg, json, '.bugs.url', skelBugsUrl);

    // name: either "@<scope>/<dir>" or unscoped "<dir>".
    const actualName = fieldAt(json, '.name');
    if (actualName !== dirName && !actualName.endsWith(`/${dirName}`)) {
      fail(
        `${pkg}: package.json .name '${actualName}' does not end with directory '${dirName}'`,
      );
    }

    // Every literal declaration target must exist or be derivable, for
    // every package (private included).
    const existenceProblems = await findDeclarationExistenceProblems(
      path.join(repoRoot, pkg),
      json,
      pkg,
    );
    existenceProblems.forEach(fail);

    // publishConfig.access: required to be "public" for non-private
    // packages.
    const isPrivate = fieldAt(json, '.private') === 'true';
    if (!isPrivate) {
      assertField(pkg, json, '.publishConfig.access', 'public');
      const declarationProblems = await findDeclarationPublicationProblems(
        path.join(repoRoot, pkg),
        json,
        pkg,
      );
      declarationProblems.forEach(fail);
    }

    // description: non-empty and not equal to skel's default. Skel itself
    // is exempt because skel defines the default the check forbids.
    if (pkg !== SKEL_REL) {
      const actualDesc = fieldAt(json, '.description');
      if (actualDesc === '') {
        fail(`${pkg}: package.json .description is empty`);
      } else if (actualDesc === skelDescription) {
        fail(
          `${pkg}: package.json .description matches skel's default ('${skelDescription}')`,
        );
      }
    }
  }

  process.exit(exitCode);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
