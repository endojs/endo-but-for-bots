// @ts-check
//
// The concrete `prepareSpawnFiles` seam: per-spawn files in a private (0700)
// directory, each written 0600.
//
//   mcp.json       the `--mcp-config` naming exactly the one relay server
//   settings.json  the `--settings` carrying the `apiKeyHelper`, `/bin/cat`
//                  of the credential file (the one credential path `--bare`
//                  honors; no helper script, so a noexec temporary directory
//                  still works), and `enabledPlugins` switching off the
//                  builtin plugins
//   credential     the acquired credential
//
// A Claude subscription OAuth access token (`sk-ant-oat…`) is the exception:
// `claude` presents an `apiKeyHelper` value as an API key, and a live turn on
// 2.1.280 got `401 authentication_failed` retries until the wall clock. The
// same token is honored as `ANTHROPIC_AUTH_TOKEN`, so for it the settings
// file carries `env` with that variable instead, and no credential file is
// written.
//
// The credential never enters the spawn environment, argv, or the MCP
// config: `claude` obtains it by running the helper. It still lives inside the
// confinement boundary as a file `claude` can reach (the DD7 residual that
// README.md § Known gaps names); a harness-side egress proxy is the named
// resolution.
//
// The design prefers a pipe- or memfd-backed `/dev/fd/N` path to an on-disk
// config (designs/endo-guest-stdio-mcp.md § Avoiding a temporary config
// file). That needs extra inherited descriptors on the `claude` spawn and a
// live check that the pinned CLI reads `--settings` only once; until then these
// are 0600 files in a 0700 directory removed on every exit path.

import fs from 'node:fs/promises';
import path from 'node:path';

import { makeError, X, q } from '@endo/errors';

import { renderApiKeyHelperSettings } from './credentials-pool.js';

/** @import { SpawnFiles } from './claude.types.js' */

/** The prefix of a Claude subscription OAuth access token. */
export const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Builtin plugins that `--bare` does not skip: on 2.1.280 `init` lists
 * `agents-md` and `telemetry` under `--bare`, and this setting is what removes
 * them (`--settings` is honored even with `--setting-sources ""`).
 */
export const DISABLED_BUILTIN_PLUGINS = harden({
  'agents-md@builtin': false,
  'telemetry@builtin': false,
});

/**
 * @param {object} options
 * @param {string} options.parentDir - a directory private to the harness.
 * @param {(sessionTag: string) => Promise<string>} options.credentialFor -
 *   the credential acquired for this spawn's session tag.
 * @param {string} options.pathValue - the PATH the confined child sees.
 */
export const makeSpawnFilesPreparer = ({
  parentDir,
  credentialFor,
  pathValue,
}) => {
  /**
   * @param {{ sessionTag: string, mcpConfigJson: string, settingsJson: string }} args
   * @returns {Promise<SpawnFiles>}
   */
  const prepareSpawnFiles = async ({
    sessionTag,
    mcpConfigJson,
    settingsJson,
  }) => {
    // The harness renders a placeholder helper; only its shape is checked here.
    const placeholder = JSON.parse(settingsJson);
    if (
      Object.keys(placeholder).length !== 1 ||
      typeof placeholder.apiKeyHelper !== 'string'
    ) {
      throw makeError(X`settings must carry exactly one key, apiKeyHelper`);
    }

    const dir = await fs.mkdtemp(path.join(parentDir, 'spawn-'));
    const cleanup = () => fs.rm(dir, { recursive: true, force: true });
    try {
      await fs.chmod(dir, 0o700);
      if (/['\\\n]/.test(dir)) {
        throw makeError(X`spawn directory ${q(dir)} is not shell-safe`);
      }
      const credentialPath = path.join(dir, 'credential');
      const mcpConfigPath = path.join(dir, 'mcp.json');
      const settingsPath = path.join(dir, 'settings.json');

      const credential = await credentialFor(sessionTag);
      if (typeof credential !== 'string' || /[\r\n]/.test(credential)) {
        throw makeError(X`credential must be a single-line string`);
      }
      // `claude` runs the helper through a shell; the path was checked to be
      // free of quote, backslash, and newline above.
      const apiKeyHelperCommand = `/bin/cat -- '${credentialPath}'`;
      /** @type {object} */
      let credentialSettings;
      if (credential.startsWith(OAUTH_TOKEN_PREFIX)) {
        credentialSettings = { env: { ANTHROPIC_AUTH_TOKEN: credential } };
      } else {
        await fs.writeFile(credentialPath, credential, { mode: 0o600 });
        credentialSettings = renderApiKeyHelperSettings(apiKeyHelperCommand);
      }
      const settings = {
        ...credentialSettings,
        enabledPlugins: DISABLED_BUILTIN_PLUGINS,
      };
      await fs.writeFile(mcpConfigPath, mcpConfigJson, { mode: 0o600 });
      await fs.writeFile(settingsPath, JSON.stringify(settings), {
        mode: 0o600,
      });
      return harden({
        mcpConfigPath,
        settingsPath,
        apiKeyHelperCommand,
        pathValue,
        cleanup,
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
  return prepareSpawnFiles;
};
harden(makeSpawnFilesPreparer);
