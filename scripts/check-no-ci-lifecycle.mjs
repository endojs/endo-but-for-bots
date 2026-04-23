#!/usr/bin/env node
// @ts-check

// Enforces that every GitHub Actions workflow in this repository runs
// package installs with npm lifecycle scripts disabled.
//
// Policy (see designs/ci-no-npm-lifecycle.md):
//
// 1. The checked-in .yarnrc.yml MUST contain `enableScripts: false`.
// 2. Every workflow that calls a package manager to install must either
//    a) pass an explicit opt-out flag to npm
//       (`--ignore-scripts`), or
//    b) declare a workflow-level or job-level `env:` block setting both
//       `YARN_ENABLE_SCRIPTS: 'false'` and
//       `npm_config_ignore_scripts: 'true'`.
// 3. No workflow step may invoke `yarn publish`, `npm publish`, or
//    `lerna publish` outside the release workflow whose job name is
//    listed in RELEASE_JOB_ALLOWLIST.
//
// This script does not parse YAML structurally; it treats each workflow
// file as text. That is adequate for the policy above and avoids adding
// a YAML dependency to the repository.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
const yarnrcPath = join(repoRoot, '.yarnrc.yml');

/** @type {string[]} */
const errors = [];

// Commands that trigger a package manager install and may run lifecycle
// scripts unless disabled.
const INSTALL_COMMAND_PATTERNS = [
  // Matches: yarn install, yarn install --something, bare `yarn`
  // Does NOT match: yarn workspace, yarn lerna, yarn build, yarn pack,
  // yarn run, yarn allow-scripts, yarn docs, yarn test, etc.
  /(?<![\w-])yarn(?:\s+install(?:\s|$)|\s*$)/,
  /(?<![\w-])npm\s+install(?:\s|$)/,
  /(?<![\w-])npm\s+i(?:\s|$)/,
  /(?<![\w-])npm\s+ci(?:\s|$)/,
];

// Commands that publish artifacts; outside the release allowlist, these
// are rejected.
const PUBLISH_COMMAND_PATTERNS = [
  /(?<![\w-])yarn\s+publish(?:\s|$)/,
  /(?<![\w-])npm\s+publish(?:\s|$)/,
  /(?<![\w-])lerna\s+publish(?:\s|$)/,
];

/** Workflows and job names where publish is allowed. */
const RELEASE_JOB_ALLOWLIST = new Set([
  'release.yml:release',
  'familiar-release.yml:release',
]);

/** Check that .yarnrc.yml retains the repo-level posture. */
const checkYarnrc = () => {
  let contents;
  try {
    contents = readFileSync(yarnrcPath, 'utf8');
  } catch (e) {
    errors.push(
      `.yarnrc.yml not readable at ${yarnrcPath}: ${
        /** @type {Error} */ (e).message
      }`,
    );
    return;
  }
  if (!/^\s*enableScripts:\s*false\s*$/m.test(contents)) {
    errors.push(
      '.yarnrc.yml must contain `enableScripts: false` at top level',
    );
  }
};

/**
 * Return whether the workflow text contains an `env:` block setting both
 * YARN_ENABLE_SCRIPTS to 'false' and npm_config_ignore_scripts to 'true'
 * at the workflow level (top of the file, before any `jobs:`).
 * We also accept the same pattern appearing anywhere above a given line
 * offset, which covers per-job env blocks for jobs that set their own
 * env. A full structural parse is overkill for this policy.
 *
 * @param {string} text
 * @returns {boolean}
 */
const hasGlobalIgnoreScriptsEnv = text => {
  // Look for both keys with literal false/true values somewhere in the
  // file. The workflow-level env block is the canonical placement; per-job
  // blocks are accepted because jobs that set their own `env:` inherit
  // nothing from the workflow level and must restate the policy.
  const hasYarnEnv = /YARN_ENABLE_SCRIPTS:\s*['"]?false['"]?/.test(text);
  const hasNpmEnv = /npm_config_ignore_scripts:\s*['"]?true['"]?/.test(text);
  return hasYarnEnv && hasNpmEnv;
};

/**
 * Check whether a line that contains an install command is covered by a
 * local `--ignore-scripts` flag on the same line.
 *
 * @param {string} line
 * @returns {boolean}
 */
const hasIgnoreScriptsFlag = line => /--ignore-scripts(?:\s|$|=)/.test(line);

/**
 * Check a single workflow file.
 *
 * @param {string} filename
 * @param {string} text
 */
const checkWorkflow = (filename, text) => {
  const hasEnv = hasGlobalIgnoreScriptsEnv(text);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip comments.
    const commentIndex = line.indexOf('#');
    const effective =
      commentIndex === -1 ? line : line.slice(0, commentIndex);

    for (const pattern of INSTALL_COMMAND_PATTERNS) {
      if (pattern.test(effective)) {
        if (hasIgnoreScriptsFlag(effective)) continue;
        if (hasEnv) continue;
        errors.push(
          `${filename}:${i + 1}: install command without scripts-disabled env or flag: ${line.trim()}`,
        );
      }
    }

    for (const pattern of PUBLISH_COMMAND_PATTERNS) {
      if (pattern.test(effective)) {
        // Heuristic: find the nearest `name:` key above this line to
        // identify the job name. Workflow file names are used as the
        // first half of the allowlist key.
        const jobName = findNearestJobName(lines, i);
        const allowlistKey = `${filename}:${jobName}`;
        if (!RELEASE_JOB_ALLOWLIST.has(allowlistKey)) {
          errors.push(
            `${filename}:${i + 1}: publish command outside release allowlist (${allowlistKey}): ${line.trim()}`,
          );
        }
      }
    }
  }
};

/**
 * Walk backward to find the closest `JOBS_KEY: <name>` style header. We
 * match the two-space-indented `name: <value>` or the job-id key that
 * introduces a job (four-space indented `<id>:`). This is a best-effort
 * heuristic; the allowlist keys are the ground truth.
 *
 * @param {string[]} lines
 * @param {number} fromIndex
 * @returns {string}
 */
const findNearestJobName = (lines, fromIndex) => {
  for (let j = fromIndex; j >= 0; j -= 1) {
    const m = lines[j].match(/^\s{0,4}([A-Za-z_][\w-]*):\s*$/);
    if (m) return m[1];
  }
  return '<unknown>';
};

// --- main ---

checkYarnrc();

let files;
try {
  files = readdirSync(workflowsDir).filter(name => name.endsWith('.yml'));
} catch (e) {
  errors.push(
    `.github/workflows not readable: ${/** @type {Error} */ (e).message}`,
  );
  files = [];
}

for (const name of files) {
  const path = join(workflowsDir, name);
  const text = readFileSync(path, 'utf8');
  checkWorkflow(name, text);
}

if (errors.length > 0) {
  process.stderr.write(
    `check-no-ci-lifecycle: ${errors.length} violation(s)\n\n`,
  );
  for (const message of errors) {
    process.stderr.write(`  ${message}\n`);
  }
  process.stderr.write(
    '\nSee designs/ci-no-npm-lifecycle.md for the policy.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `check-no-ci-lifecycle: ${files.length} workflow(s) OK\n`,
);
