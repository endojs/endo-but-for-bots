#!/usr/bin/env node
// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lint } from 'markdownlint/promise';

import sentencePerLine from './markdown-sentence-per-line.mjs';

const intendedRoots = new Set([
  '.github',
  'designs',
  'docs',
  'packages',
  'scripts',
]);
const excludedSegments =
  /(?:^|\/)(?:fixtures?(?:-[^/]*)?|node_modules|test262|vendor(?:ed)?)(?:\/|$)/;
const fallbackPaths = new Set([
  '.node-version',
  '.prettierignore',
  '.prettierrc.json',
  '.github/workflows/ci-docs.yml',
  '.github/workflows/ci.yml',
  'package.json',
  'yarn.lock',
]);

/**
 * Run Git and return stdout.
 *
 * @param {string[]} arguments_ Git arguments.
 * @returns {string}
 */
const git = arguments_ =>
  execFileSync('git', arguments_, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * Split NUL-delimited Git output.
 *
 * @param {string} output
 * @returns {string[]}
 */
const splitPaths = output => output.split('\0').filter(Boolean);

/**
 * Whether a path belongs to the maintained Markdown corpus.
 *
 * @param {string} path
 * @returns {boolean}
 */
export const isIntendedMarkdown = path => {
  if (!path.endsWith('.md') || excludedSegments.test(path)) {
    return false;
  }
  if (/^packages\/[^/]+\/CHANGELOG\.md$/.test(path)) {
    return false;
  }
  if (path.startsWith('scripts/markdown-lint-fixtures/')) {
    return false;
  }
  const [root] = path.split('/');
  return !path.includes('/') || intendedRoots.has(root);
};

/**
 * Whether a changed path invalidates changed-file selection.
 *
 * @param {string} path
 * @returns {boolean}
 */
export const isFullFallbackPath = path =>
  fallbackPaths.has(path) ||
  path.startsWith('scripts/lint-markdown') ||
  path.startsWith('scripts/markdown-sentence-per-line') ||
  path.startsWith('scripts/markdown-lint-fixtures/');

/**
 * Parse new-side line numbers from a zero-context unified diff.
 *
 * @param {string} diff
 * @returns {Set<number>}
 */
export const parseAddedLineNumbers = diff => {
  const lines = new Set();
  for (const line of diff.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
  }
  return lines;
};

/**
 * Resolve a diff base, preferring the current llm merge base for local use.
 *
 * @param {string | undefined} requested
 * @returns {string}
 */
export const resolveBase = requested => {
  const candidates = requested ? [requested] : ['origin/llm', 'HEAD^', 'HEAD'];
  for (const candidate of candidates) {
    try {
      git(['rev-parse', '--verify', `${candidate}^{commit}`]);
      if (candidate === 'HEAD') {
        return candidate;
      }
      return git(['merge-base', 'HEAD', candidate]).trim();
    } catch {
      // Try the next conservative local base.
    }
  }
  throw new Error('Unable to resolve a Markdown lint diff base.');
};

/**
 * Read every tracked or untracked Markdown path.
 *
 * @returns {string[]}
 */
const listAllMarkdown = () =>
  splitPaths(
    git([
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '*.md',
    ]),
  )
    .filter(isIntendedMarkdown)
    .filter(existsSync)
    .sort();

/**
 * Read paths changed against a base, including local untracked paths.
 *
 * @param {string} base
 * @returns {{ changed: string[], untracked: Set<string> }}
 */
const listChangedPaths = base => {
  const tracked = splitPaths(
    git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base, '--']),
  );
  const untracked = new Set(
    splitPaths(git(['ls-files', '-z', '--others', '--exclude-standard'])),
  );
  return {
    changed: [...new Set([...tracked, ...untracked])].sort(),
    untracked,
  };
};

/**
 * Get added line numbers for each changed Markdown file.
 *
 * @param {string} base
 * @param {string[]} paths
 * @param {Set<string>} untracked
 * @returns {Map<string, Set<number>>}
 */
const getAddedLines = (base, paths, untracked) => {
  const added = new Map();
  for (const path of paths) {
    if (untracked.has(path)) {
      const count = readFileSync(path, 'utf8').split(/\r?\n/).length;
      added.set(
        path,
        new Set(Array.from({ length: count }, (_value, index) => index + 1)),
      );
      continue;
    }
    const diff = git(['diff', '--unified=0', '--no-color', base, '--', path]);
    added.set(path, parseAddedLineNumbers(diff));
  }
  return added;
};

/**
 * Lint files and return Markdownlint results.
 *
 * @param {string[]} files
 * @returns {Promise<import('markdownlint').LintResults>}
 */
const lintFiles = files =>
  lint({
    files,
    customRules: [sentencePerLine],
    config: {
      default: false,
      'sentence-per-line': true,
    },
  });

/**
 * Parse command-line arguments.
 *
 * @param {string[]} arguments_
 * @returns {{ all: boolean, base: string | undefined, files: string[] }}
 */
const parseArguments = arguments_ => {
  let all = false;
  /** @type {string | undefined} */
  let base;
  const files = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--all') {
      all = true;
    } else if (argument === '--base') {
      base = arguments_[index + 1];
      if (!base) {
        throw new Error('--base requires a Git ref.');
      }
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      files.push(argument);
    }
  }
  if (all && (base || files.length > 0)) {
    throw new Error('--all cannot be combined with --base or file paths.');
  }
  if (base && files.length > 0) {
    throw new Error('--base cannot be combined with file paths.');
  }
  return { all, base, files };
};

/**
 * Run the command-line interface.
 *
 * @param {string[]} arguments_
 */
const main = async arguments_ => {
  const options = parseArguments(arguments_);
  /** @type {string[]} */
  let files;
  /** @type {Map<string, Set<number>> | undefined} */
  let addedLines;
  let label;

  if (options.all) {
    files = listAllMarkdown();
    label = `full corpus (${files.length} files)`;
  } else if (options.files.length > 0) {
    files = options.files.filter(existsSync);
    label = `explicit paths (${files.length} files)`;
  } else {
    const base = resolveBase(options.base);
    const { changed, untracked } = listChangedPaths(base);
    const changedMarkdown = changed
      .filter(isIntendedMarkdown)
      .filter(existsSync);
    const fullFallback = changed.some(isFullFallbackPath);
    // Tooling changes parse the entire maintained corpus so they cannot hide
    // parser or configuration regressions. Diagnostics remain limited to added
    // lines because the existing corpus predates this rule; --all audits that
    // grandfathered debt explicitly.
    files = fullFallback ? listAllMarkdown() : changedMarkdown;
    addedLines = getAddedLines(base, changedMarkdown, untracked);
    label = fullFallback
      ? `full fallback (${files.length} files)`
      : `changed Markdown (${files.length} files)`;
  }

  if (files.length === 0) {
    console.error(`Markdown sentence lint: ${label}; nothing to check.`);
    return;
  }

  const results = await lintFiles(files);
  let errorCount = 0;
  for (const [path, errors] of Object.entries(results)) {
    for (const error of errors) {
      if (addedLines && !addedLines.get(path)?.has(error.lineNumber)) {
        continue;
      }
      const column = error.errorRange?.[0] ?? 1;
      console.error(
        `${path}:${error.lineNumber}:${column} ${error.ruleNames[0]} ${error.errorDetail ?? error.ruleDescription}`,
      );
      errorCount += 1;
    }
  }
  console.error(
    `Markdown sentence lint: ${label}; ${errorCount} new violation${errorCount === 1 ? '' : 's'}.`,
  );
  if (errorCount > 0) {
    process.exitCode = 1;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
