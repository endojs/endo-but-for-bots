// @ts-check

/**
 * Decision 3's confinement recipe as argv for `claude -p`. Order matters: the
 * variadic `--tools`, `--allowedTools`, and `--mcp-config` flags must not
 * swallow a following positional, so the prompt never appears in argv at all;
 * it travels on stdin.
 *
 * @param {object} options
 * @param {string} options.mcpConfigPath  a per-turn file naming exactly one
 *   server, `guest`.
 * @param {readonly string[]} options.toolNames  the pinned, pruned catalog.
 * @param {number} options.maxTurns
 * @param {string} [options.model]
 * @param {boolean} [options.permissionPromptsNone]  add
 *   `--permission-prompts none` on CLI versions that document it.
 */
export const buildClaudeArgv = ({
  mcpConfigPath,
  toolNames,
  maxTurns,
  model,
  permissionPromptsNone = false,
}) => {
  for (const name of toolNames) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      throw Error(`tool name not allow-listable: ${JSON.stringify(name)}`);
    }
  }
  const allowed = toolNames.map(name => `mcp__guest__${name}`).join(',');
  const argv = [
    '--bare',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--tools',
    '',
    '--allowedTools',
    allowed,
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (permissionPromptsNone) argv.push('--permission-prompts', 'none');
  if (model !== undefined) argv.push('--model', model);
  return harden(argv);
};
harden(buildClaudeArgv);
