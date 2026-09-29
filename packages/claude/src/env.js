// @ts-check

/**
 * The constructed child environment. Nothing is inherited from the host
 * process: the caller names every variable.
 *
 * Decision 5's interim delivery places the credential in
 * `ANTHROPIC_AUTH_TOKEN`; the target delivery places a lease token there and
 * sets `ANTHROPIC_BASE_URL` to a loopback broker listener. This builder does
 * not distinguish them, because the binary cannot either.
 *
 * @param {object} options
 * @param {string} options.home  a fresh per-turn directory
 * @param {string} options.configDir  a fresh per-turn directory
 * @param {string} options.bearer  credential (interim) or lease token (target)
 * @param {string} [options.baseUrl]  loopback broker listener (target)
 * @param {string} [options.path]
 */
export const buildClaudeEnv = ({
  home,
  configDir,
  bearer,
  baseUrl,
  path = '/usr/local/bin:/usr/bin:/bin',
}) => {
  /** @type {Record<string, string>} */
  const env = {
    PATH: path,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_AUTH_TOKEN: bearer,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (baseUrl !== undefined) env.ANTHROPIC_BASE_URL = baseUrl;
  return harden(env);
};
harden(buildClaudeEnv);
