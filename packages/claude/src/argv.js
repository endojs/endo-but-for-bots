// @ts-check
//
// Argv construction is a confinement boundary, not a formatting detail
// (Design Decision 1, and § Argv order is a confinement boundary).
//
// The hermetic `claude -p` invocation confines Claude with a COMBINATION of
// flags, no one of which suffices. This module owns:
//
//   - the pinned CLI version whose flag semantics were last measured live
//     (2.1.280; the design's original measurement was 2.1.232);
//   - the seven presence-required flags the harness refuses to spawn without;
//   - the per-spawn path flags `--settings` and `--mcp-config`, each exactly
//     once (a repeat could substitute another file);
//   - the value assertion that `--tools` and `--setting-sources` each carry
//     exactly the empty string (presence-only is the `"alg":"none"` shape),
//     and that `--permission-mode` / `--permission-prompts` carry `dontAsk` /
//     `none`, each exactly once;
//   - that no bare token follows the value of any of those flags, since
//     `--tools` and `--mcp-config` are variadic in 2.1.280 and would absorb it;
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
export const PINNED_CLI_VERSION = '2.1.280';

/**
 * The seven flags whose PRESENCE the harness asserts before every spawn
 * (§ Design Decision 1). Three close the discovery surfaces (`--bare` closes
 * CLAUDE.md/hooks/keychain; `--strict-mcp-config` closes MCP auto-discovery;
 * `--setting-sources` closes the discovered settings layers); `--mcp-config` names
 * the only MCP servers; `--tools` empties
 * the built-in set; `--disable-slash-commands` closes the `/skill-name` surface
 * `--bare` leaves resolving and `--tools ""` does not reach; `--settings` carries
 * the `enabledPlugins` key that disables the builtin plugins `--bare` still loads.
 */
export const REQUIRED_FLAGS = harden([
  '--bare',
  '--mcp-config',
  '--strict-mcp-config',
  '--setting-sources',
  '--settings',
  '--tools',
  '--disable-slash-commands',
]);

/**
 * Flags that carry their confinement in their *value*, not their presence. Each
 * must appear exactly once with exactly this value. Any repeat is refused, so
 * which occurrence the CLI would honor does not matter.
 *
 * `--tools Bash` re-opens the built-in set, and a non-empty `--setting-sources`
 * re-admits a discovered layer, so each must carry exactly `""`. Without
 * `--permission-mode`, 2.1.280's `init` reports `permissionMode: "default"`;
 * `dontAsk` denies any tool not pre-allowed, so a tool that leaks past the
 * other layers is refused rather than run
 * (designs/endo-claude-inference-backends.md § Confinement recipe).
 * `--permission-prompts none` (new in 2.1.280) denies anything that would
 * otherwise prompt.
 */
const PINNED_VALUE_FLAGS = harden({
  '--tools': '',
  '--setting-sources': '',
  '--permission-mode': 'dontAsk',
  '--permission-prompts': 'none',
});

/**
 * Flags whose value is a per-spawn file path, so it cannot be value-pinned, but
 * whose file carries confinement: `--settings` carries `enabledPlugins` and the
 * credential, `--mcp-config` names the only MCP servers. Each may appear at most
 * once, since a repeat could substitute another file; both are also required, so
 * each appears exactly once.
 */
const SINGLE_OCCURRENCE_FLAGS = harden(['--settings', '--mcp-config']);

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
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--disallowedTools',
    [...disallowedTools].join(','),
    '--allowedTools',
    [...allowList].join(','),
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    // The launch seam reads a structured transcript, never scraped text
    // (designs/endo-guest-stdio-mcp.md § Structured signals). In print mode
    // `stream-json` requires `--verbose`.
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
  ]);

  // The harness's own output must satisfy the confinement structure (version is
  // asserted separately at spawn time against `claude --version`).
  assertConfinedArgv(argv);
  return argv;
};
harden(buildArgv);

/**
 * The seven-flag spawn-refusal predicate (§ Design Decision 1). Throws unless
 * all seven required flags are present.
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
 * `claude --help` (2.1.280) documents `--tools <tools...>` and
 * `--mcp-config <configs...>` as variadic: one occurrence absorbs every
 * following bare token, so `--tools "" Bash` yields `"tools":["Bash"]` and
 * `--mcp-config legit.json attacker.json` loads both files. The token after a
 * checked flag's value must therefore be absent or another `--` flag.
 *
 * @param {readonly string[]} argv
 * @param {string} flag
 * @param {number} at index of `flag` in `argv`
 */
const assertNoTrailingBareToken = (argv, flag, at) => {
  const next = argv[at + 2];
  if (next !== undefined && !next.startsWith('--')) {
    throw makeError(
      X`confinement: bare token ${q(next)} follows the value of ${q(flag)}`,
    );
  }
};

/**
 * `--tools`, `--setting-sources`, `--permission-mode`, and `--permission-prompts`
 * are value-asserted, not presence-asserted: each must appear exactly once, the
 * token immediately after it must be exactly its pinned value, and no bare token
 * may follow that value.
 *
 * @param {readonly string[]} argv
 */
export const assertPinnedValueFlags = argv => {
  for (const [flag, value] of Object.entries(PINNED_VALUE_FLAGS)) {
    const at = argv.indexOf(flag);
    if (at === -1) {
      throw makeError(X`confinement: pinned-value flag ${q(flag)} missing`);
    }
    if (argv[at + 1] !== value) {
      throw makeError(
        X`confinement: flag ${q(flag)} must carry ${q(value)}, got ${q(
          argv[at + 1],
        )}`,
      );
    }
    assertNoTrailingBareToken(argv, flag, at);
    if (argv.indexOf(flag, at + 1) !== -1) {
      throw makeError(X`confinement: flag ${q(flag)} appears more than once`);
    }
  }
};
harden(assertPinnedValueFlags);

/**
 * `--settings` and `--mcp-config` each appear at most once, so a trailing
 * occurrence cannot substitute an attacker-chosen file, and no bare token may
 * follow the path, so variadic `--mcp-config` cannot absorb a second file.
 *
 * @param {readonly string[]} argv
 */
export const assertSingleOccurrenceFlags = argv => {
  for (const flag of SINGLE_OCCURRENCE_FLAGS) {
    const at = argv.indexOf(flag);
    if (at !== -1) {
      assertNoTrailingBareToken(argv, flag, at);
      if (argv.indexOf(flag, at + 1) !== -1) {
        throw makeError(X`confinement: flag ${q(flag)} appears more than once`);
      }
    }
  }
};
harden(assertSingleOccurrenceFlags);

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
 * required flags present, pinned-value flags (including the empty-value
 * `--tools` and `--setting-sources`) each appear once with their value,
 * `--settings` and `--mcp-config` each at most once, no bare token after any of
 * those flags' values, no transcript resume.
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
  assertPinnedValueFlags(argv);
  assertSingleOccurrenceFlags(argv);
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
