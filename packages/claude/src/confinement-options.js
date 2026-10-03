// @ts-check
//
// The confinement recipe of designs/endo-claude-inference-backends.md
// Decision 3, rendered for both Claude front ends: argv for `claude -p` and an
// options record for the Agent SDK. Both carry the same settings, because the
// SDK turns each option into the same CLI flag underneath.

import { Fail, q } from '@endo/errors';
import { renderAllowedTools } from '@endo/agent-tools/adapters/mcp.js';

import {
  assertConfinedArgv,
  assertPinnedVersion,
  buildConfinementFlags,
} from './argv.js';
import {
  KNOWN_BUILTIN_TOOLS,
  isAdmissibleServerName,
  isAdmissibleToolName,
} from './tool-permissions.js';

/** @import { CliArgumentsSpec, SdkOptionsSpec } from './backends.types.js' */

/**
 * Renders the exact `mcp__<server>__<tool>` allow-list for a projection's
 * pinned catalog. Never a wildcard: a tool the catalog does not name is not
 * allowed even if the server later serves it.
 *
 * @param {string} serverName
 * @param {readonly string[]} toolNames
 * @returns {readonly string[]}
 */
export const confinedAllowList = (serverName, toolNames) => {
  isAdmissibleServerName(serverName) ||
    Fail`invalid MCP server name ${q(serverName)}`;
  toolNames.length > 0 ||
    Fail`a projection with no tools cannot run a confined turn`;
  for (const name of toolNames) {
    isAdmissibleToolName(name) || Fail`inadmissible tool name ${q(name)}`;
  }
  return renderAllowedTools({ names: [...toolNames] }, serverName);
};
harden(confinedAllowList);

/**
 * @param {number} maxTurns
 */
const assertTurnCeiling = maxTurns => {
  (Number.isInteger(maxTurns) && maxTurns > 0) ||
    Fail`maxTurns must be a positive integer, got ${q(maxTurns)}`;
};

/**
 * @param {number | undefined} maxBudgetUsd
 */
const assertBudgetCeiling = maxBudgetUsd => {
  maxBudgetUsd === undefined ||
    (typeof maxBudgetUsd === 'number' &&
      Number.isFinite(maxBudgetUsd) &&
      maxBudgetUsd > 0) ||
    Fail`maxBudgetUsd must be a positive finite number, got ${q(maxBudgetUsd)}`;
};

/**
 * Builds the argv (after the binary name) for one confined `claude -p` turn.
 * The prompt is not an argument: it goes on stdin, so it never appears in
 * `/proc/<pid>/cmdline` and cannot be swallowed by a variadic flag. The
 * credential is not an argument either; it arrives in the constructed
 * environment.
 *
 * @param {CliArgumentsSpec} spec
 * @returns {readonly string[]}
 */
export const buildCliArguments = ({
  mcpConfigPath,
  settingsPath,
  serverName,
  toolNames,
  maxTurns,
  model,
  maxBudgetUsd,
  permissionPromptsNone = false,
}) => {
  (typeof mcpConfigPath === 'string' && mcpConfigPath !== '') ||
    Fail`mcpConfigPath must be a non-empty string`;
  (typeof settingsPath === 'string' && settingsPath !== '') ||
    Fail`settingsPath must be a non-empty string`;
  assertTurnCeiling(maxTurns);
  assertBudgetCeiling(maxBudgetUsd);
  if (model !== undefined) {
    // A model value beginning with `-` would read as a flag.
    /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(model) ||
      Fail`model ${q(model)} is not a plain model identifier`;
  }
  const allowList = confinedAllowList(serverName, toolNames);

  const argv = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'text',
    ...buildConfinementFlags({ mcpConfigPath, settingsPath, allowList }),
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    String(maxTurns),
  ];
  if (permissionPromptsNone) {
    argv.push('--permission-prompts', 'none');
  }
  if (model !== undefined) {
    argv.push('--model', model);
  }
  if (maxBudgetUsd !== undefined) {
    argv.push('--max-budget-usd', String(maxBudgetUsd));
  }
  harden(argv);
  assertConfinedArgv(argv);
  return argv;
};
harden(buildCliArguments);

/**
 * Builds the Agent SDK `query` options for one confined turn: the CLI recipe
 * as typed options, with the projection's MCP server handed over in process.
 * The projection's formula identifier is deliberately absent; it is an audit
 * label and never reaches the provider.
 *
 * @param {SdkOptionsSpec} spec
 * @returns {Record<string, unknown>} the `options` of one Agent SDK `query`
 *   call
 */
export const buildSdkOptions = ({
  serverName,
  toolNames,
  mcpServer,
  maxTurns,
  model,
  workingDirectory,
  environment,
  executablePath,
  abortController,
  maxBudgetUsd,
}) => {
  assertTurnCeiling(maxTurns);
  assertBudgetCeiling(maxBudgetUsd);
  const allowList = confinedAllowList(serverName, toolNames);
  // Not `harden`ed, unlike the CLI argv: `harden` is transitive and would
  // freeze the in-process MCP server instance and the abort controller, which
  // the SDK must still drive.
  return {
    abortController,
    pathToClaudeCodeExecutable: executablePath,
    cwd: workingDirectory,
    // A fresh copy of the hardened constructed environment, as the CLI backend
    // makes: the SDK spawns the pinned binary with this record, and Node's
    // spawn writes into `options.env` (it adds NODE_V8_COVERAGE when the
    // parent has it), which throws on a frozen record.
    env: { ...environment },
    tools: [],
    disallowedTools: [...KNOWN_BUILTIN_TOOLS],
    allowedTools: [...allowList],
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    mcpServers: {
      [serverName]: { type: 'sdk', name: serverName, instance: mcpServer },
    },
    permissionMode: 'dontAsk',
    persistSession: false,
    maxTurns,
    ...(model === undefined ? {} : { model }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
  };
};
harden(buildSdkOptions);

/**
 * Checks the binary a turn would run against the version the confinement
 * recipe was measured on. An upgraded binary may have changed the flag
 * semantics, so it must not receive a credential.
 *
 * @param {() => string | Promise<string>} getVersion
 * @param {string} pinnedVersion
 * @returns {Promise<string | undefined>} why the turn may not run, if it may not
 */
export const checkPinnedVersion = async (getVersion, pinnedVersion) => {
  try {
    assertPinnedVersion(await getVersion(), pinnedVersion);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
harden(checkPinnedVersion);
