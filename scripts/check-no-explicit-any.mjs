#!/usr/bin/env node
// @ts-check

/**
 * @file Ratchet the repository's baseline of explicit `any` types.
 *
 * The `@endo/eslint-plugin` `internal` config rejects explicit `any` (and its
 * JSDoc spelling `*`) everywhere: `jsdoc/reject-any-type` for JSDoc types and
 * `@typescript-eslint/no-explicit-any` for TypeScript syntax. Files that
 * predate the rule are listed, with their violation counts, in
 * `eslint-no-explicit-any-baseline.json`, and the root `eslint.config.js`
 * turns both rules off for exactly those files. That keeps every ESLint
 * invocation consistent -- the bucketed root lint, a package's own
 * `lint:eslint`, and an editor integration -- which ESLint's CLI-only bulk
 * suppressions file could not do.
 *
 * Because the baseline exempts whole files, this script re-counts the
 * violations in every lintable file and fails closed when:
 *
 *   - a baselined file gains an explicit `any` (its count rose),
 *   - a baselined file lost one but the baseline was not lowered to match,
 *   - a baselined file no longer exists, or
 *   - a file outside the baseline has one (ESLint reports these too).
 *
 * The baseline may only shrink. Burn down a file's `any`s, then run
 *
 *   node scripts/check-no-explicit-any.mjs --update
 *
 * and commit the regenerated baseline. `--update` refuses to raise any
 * file's allowance. A genuinely irreducible `any` takes an
 * `eslint-disable-next-line` comment naming the rule and explaining why;
 * this script honors those directives just as ESLint does.
 *
 * The count is syntactic, so it lints without type information and runs in
 * one process over the whole repository.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tsEslintParser from '@typescript-eslint/parser';
import tsEslintPlugin from '@typescript-eslint/eslint-plugin';
import jsdocPlugin from 'eslint-plugin-jsdoc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'eslint-no-explicit-any-baseline.json');

const ruleIds = ['jsdoc/reject-any-type', '@typescript-eslint/no-explicit-any'];

const update = process.argv.includes('--update');

/** @returns {Record<string, number>} */
const readBaseline = () => JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

/**
 * Tracked files that the repository's own ESLint configuration lints.
 *
 * @returns {Promise<string[]>}
 */
const listLintedFiles = async () => {
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      '*.js',
      '*.mjs',
      '*.cjs',
      '*.ts',
      '*.mts',
      '*.cts',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(file => file !== '' && fs.existsSync(path.join(root, file)));
  const repoLint = new ESLint({ cwd: root });
  /** @type {string[]} */
  const linted = [];
  for (const file of tracked) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await repoLint.isPathIgnored(path.join(root, file)))) {
      linted.push(file);
    }
  }
  return linted;
};

/**
 * Count explicit `any` violations per file, honoring disable directives.
 *
 * @param {string[]} files
 * @returns {Promise<Record<string, number>>}
 */
const countViolations = async files => {
  const counter = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        languageOptions: {
          parser: tsEslintParser,
          sourceType: 'module',
        },
        linterOptions: {
          reportUnusedDisableDirectives: 'off',
          reportUnusedInlineConfigs: 'off',
        },
        plugins: {
          '@typescript-eslint': tsEslintPlugin,
          jsdoc: jsdocPlugin,
        },
        settings: { jsdoc: { mode: 'typescript' } },
        rules: Object.fromEntries(ruleIds.map(ruleId => [ruleId, 'error'])),
      },
    ],
  });
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {string[]} */
  const failures = [];
  const results = await counter.lintFiles(
    files.map(file => path.join(root, file)),
  );
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join('/');
    let count = 0;
    for (const message of result.messages) {
      if (message.fatal) {
        failures.push(`${file}:${message.line}: ${message.message}`);
      } else if (message.ruleId && ruleIds.includes(message.ruleId)) {
        count += 1;
      }
    }
    if (count > 0) {
      counts[file] = count;
    }
  }
  if (failures.length > 0) {
    throw Error(`Could not parse:\n  ${failures.join('\n  ')}`);
  }
  return counts;
};

/** @param {Record<string, number>} counts */
const sortedEntries = counts =>
  Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const main = async () => {
  const counts = await countViolations(await listLintedFiles());
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const baseline = readBaseline();
  /** @type {string[]} */
  const problems = [];
  for (const [file, count] of sortedEntries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      problems.push(
        `${file}: ${count} explicit any, baseline allows ${allowed}. Use a specific type.`,
      );
    }
  }
  for (const [file, allowed] of sortedEntries(baseline)) {
    const count = counts[file] ?? 0;
    if (count < allowed && !update) {
      problems.push(
        `${file}: ${count} explicit any, baseline still allows ${allowed}. Lower it with --update.`,
      );
    }
  }
  if (update && problems.length === 0) {
    const text = `${JSON.stringify(Object.fromEntries(sortedEntries(counts)), null, 2)}\n`;
    fs.writeFileSync(baselinePath, text);
    console.log(
      `Wrote ${path.relative(root, baselinePath)}: ${total} explicit any in ${Object.keys(counts).length} files.`,
    );
    return;
  }
  if (problems.length > 0) {
    console.error(
      `Explicit any baseline drift (${path.relative(root, baselinePath)}):\n  ${problems.join('\n  ')}`,
    );
    console.error(
      'The baseline may only shrink: remove explicit any, then run `node scripts/check-no-explicit-any.mjs --update`.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Explicit any baseline holds: ${total} in ${Object.keys(counts).length} files.`,
  );
};

await main();
