// @ts-check
//
// Argv construction is a confinement boundary, not a formatting detail
// (Design Decision 1, and § Argv order is a confinement boundary).
//
// The hermetic `claude -p` invocation confines Claude with a COMBINATION of
// flags, no one of which suffices. This module owns:
//
//   - the pinned CLI version whose flag semantics the design measured (2.1.232);
//   - the five presence-required flags the harness refuses to spawn without;
//   - the value assertion that `--tools` and `--setting-sources` each carry
//     exactly the empty string (presence-only is the `"alg":"none"` shape);
//   - `buildArgv`, which emits the prompt at NO index (it is delivered on stdin),
//     so the construction invariant holds by construction.

import { makeError, X, q } from '@endo/errors';
import { KNOWN_BUILTIN_TOOLS } from './tool-permissions.js';

/**
 * The Claude Code version whose flag behaviour this design measured. Confinement
 * here is a *measurement* of one version's flag semantics, so an upgraded
 * `claude` on PATH — which would spawn happily with silently changed semantics —
 * must fail closed until the live confinement test is re-run against it.
 */
export const PINNED_CLI_VERSION = '2.1.232';

/**
 * The five flags whose PRESENCE the harness asserts before every spawn
 * (§ Design Decision 1). Three close the discovery surfaces (`--bare` closes
 * CLAUDE.md/hooks/keychain; `--strict-mcp-config` closes MCP auto-discovery;
 * `--setting-sources` closes the discovered settings layers); `--tools` empties
 * the built-in set; `--disable-slash-commands` closes the `/skill-name` surface
 * `--bare` leaves resolving and `--tools ""` does not reach.
 */
export const REQUIRED_FLAGS = harden([
  '--bare',
  '--strict-mcp-config',
  '--setting-sources',
  '--tools',
  '--disable-slash-commands',
]);

/**
 * `--tools` and `--setting-sources` carry their confinement in their *value*, not
 * their presence: `--tools Bash` re-opens the built-in set, and a non-empty
 * `--setting-sources` re-admits a discovered layer. Each must carry exactly `""`.
 */
const EMPTY_VALUE_FLAGS = harden(['--tools', '--setting-sources']);

/**
 * Flags that must NEVER appear: both restore the full prior transcript (past tool
 * calls and their results) with no documented filter, regardless of the new
 * invocation's tool-permission flags.
 */
const FORBIDDEN_FLAGS = harden(['--resume', '--continue', '-r', '-c']);

/**
 * @typedef {object} ArgvSpec
 * @property {string} mcpConfigPath   Absolute path to the generated `--mcp-config` file.
 * @property {string} settingsPath    Absolute path to the generated `--settings` file.
 * @property {readonly string[]} allowList  `mcp__<server>__<tool>` entries (already validated).
 * @property {string} model           A value already validated by membership in the pinned model set.
 * @property {number} maxTurns        Harness-fixed agent-turn ceiling.
 * @property {readonly string[]} [disallowedTools]  Belt deny set (defaults to the known built-ins).
 */

/**
 * Build the confined `claude -p` argv from harness-owned tokens ONLY. The prompt
 * is NOT a parameter and appears at no index — it is delivered on stdin — so a
 * prompt can never be swallowed by an adjacent variadic flag.
 *
 * Variadic flag values (`--mcp-config`, `--allowedTools`, `--disallowedTools`)
 * are emitted as a SINGLE comma-joined token each, so there is no multi-token
 * value run for a following positional to be swallowed into.
 *
 * @param {ArgvSpec} spec
 * @returns {readonly string[]}
 */
export const buildArgv = spec => {
  const {
    mcpConfigPath,
    settingsPath,
    allowList,
    model,
    maxTurns,
    disallowedTools = KNOWN_BUILTIN_TOOLS,
  } = spec;

  if (typeof mcpConfigPath !== 'string' || mcpConfigPath.length === 0) {
    throw makeError(X`buildArgv: mcpConfigPath must be a non-empty string`);
  }
  if (typeof settingsPath !== 'string' || settingsPath.length === 0) {
    throw makeError(X`buildArgv: settingsPath must be a non-empty string`);
  }
  if (!Array.isArray(allowList) || allowList.length === 0) {
    throw makeError(X`buildArgv: allowList must be a non-empty array`);
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw makeError(X`buildArgv: model must be a non-empty string`);
  }
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw makeError(X`buildArgv: maxTurns must be a positive integer`);
  }

  const argv = harden([
    '--bare',
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--settings',
    settingsPath,
    '--tools',
    '',
    '--disable-slash-commands',
    '--disallowedTools',
    [...disallowedTools].join(','),
    '--allowedTools',
    [...allowList].join(','),
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    '-p',
  ]);

  // The harness's own output must satisfy the confinement structure (version is
  // asserted separately at spawn time against `claude --version`).
  assertConfinedArgv(argv);
  return argv;
};
harden(buildArgv);

/**
 * The five-flag spawn-refusal predicate (§ Design Decision 1). Throws unless all
 * five required flags are present.
 *
 * @param {readonly string[]} argv
 */
export const assertRequiredFlags = argv => {
  for (const flag of REQUIRED_FLAGS) {
    if (!argv.includes(flag)) {
      throw makeError(
        X`confinement: required flag ${q(flag)} missing from claude argv`,
      );
    }
  }
};
harden(assertRequiredFlags);

/**
 * `--tools` and `--setting-sources` are value-asserted, not presence-asserted:
 * the token immediately after each must be exactly the empty string.
 *
 * @param {readonly string[]} argv
 */
export const assertEmptyValueFlags = argv => {
  for (const flag of EMPTY_VALUE_FLAGS) {
    const at = argv.indexOf(flag);
    if (at === -1) {
      throw makeError(X`confinement: value-bearing flag ${q(flag)} missing`);
    }
    if (argv[at + 1] !== '') {
      throw makeError(
        X`confinement: flag ${q(flag)} must carry exactly the empty string, got ${q(
          argv[at + 1],
        )}`,
      );
    }
  }
};
harden(assertEmptyValueFlags);

/**
 * No `--resume` / `--continue` (or their short forms) may appear.
 *
 * @param {readonly string[]} argv
 */
export const assertNoTranscriptResume = argv => {
  for (const flag of FORBIDDEN_FLAGS) {
    if (argv.includes(flag)) {
      throw makeError(
        X`confinement: forbidden transcript-resume flag ${q(flag)} present`,
      );
    }
  }
};
harden(assertNoTranscriptResume);

/**
 * The full structural confinement gate over an argv (version-independent):
 * required flags present, empty-value flags carry `""`, no transcript resume.
 * `buildArgv` output always passes this; the property tests feed it arbitrary
 * argvs.
 *
 * @param {readonly string[]} argv
 */
export const assertConfinedArgv = argv => {
  if (!Array.isArray(argv)) {
    throw makeError(X`confinement: argv must be an array`);
  }
  assertRequiredFlags(argv);
  assertEmptyValueFlags(argv);
  assertNoTranscriptResume(argv);
};
harden(assertConfinedArgv);

/**
 * Assert the on-PATH `claude --version` equals the pinned version. Fail closed on
 * any mismatch: an upgraded CLI may have changed the flag semantics this design's
 * confinement rests on.
 *
 * @param {string} actualVersion
 * @param {string} [pinnedVersion]
 */
export const assertPinnedVersion = (
  actualVersion,
  pinnedVersion = PINNED_CLI_VERSION,
) => {
  if (actualVersion !== pinnedVersion) {
    throw makeError(
      X`confinement: claude --version ${q(actualVersion)} != pinned ${q(
        pinnedVersion,
      )}; re-run the live confinement test before raising the pin`,
    );
  }
};
harden(assertPinnedVersion);
