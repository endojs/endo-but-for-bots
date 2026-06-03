/* global process */
// @ts-check

/**
 * @file Gateway path helpers for the `endo gateway` CLI subcommands.
 *
 * Wraps `@endo/gateway`'s pure `detectServiceMode` /
 * `resolveGatewayPaths` resolver with the host info the CLI assembles
 * once (user, home, temp), and exposes a single `resolveCliPaths`
 * function the `endo gateway` subcommands consult.
 *
 * The CLI lives a layer above the resolver because the resolver is
 * pure (no `os`, no `process`); the CLI is the layer that knows how
 * to fill in `process.platform`, `process.env`, and the `os.userInfo`
 * triple. Tests of the resolver bypass this module and exercise the
 * pure surface directly.
 */

import os from 'os';

import { detectServiceMode, resolveGatewayPaths } from '@endo/gateway';

/**
 * Resolve gateway paths for the current host. Determines the service
 * mode from `process.geteuid()`, the `INVOCATION_ID` env var, and the
 * caller-supplied `--system` flag, then resolves every directory and
 * the config-file path.
 *
 * @param {object} [args]
 * @param {boolean} [args.explicit] Caller-supplied `--system` flag.
 * @param {string} [args.platform] Defaults to `process.platform`.
 * @param {{[name: string]: string | undefined}} [args.env] Defaults to
 *   `process.env`.
 * @returns {{
 *   mode: 'system' | 'user',
 *   stateDir: import('@endo/gateway').GatewayPathResolution,
 *   runtimeDir: import('@endo/gateway').GatewayPathResolution,
 *   logDir: import('@endo/gateway').GatewayPathResolution,
 *   cacheDir: import('@endo/gateway').GatewayPathResolution,
 *   configFile: import('@endo/gateway').GatewayPathResolution,
 * }}
 */
export const resolveCliPaths = ({
  explicit = false,
  platform = process.platform,
  env = process.env,
} = {}) => {
  // process.geteuid is undefined on Windows; the detector tolerates it.
  const uid =
    typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  const mode = detectServiceMode({ uid, env, explicit });

  const { homedir, username } = os.userInfo();
  const info = { home: homedir, user: username };

  const paths = resolveGatewayPaths({ mode, platform, env, info });
  return {
    mode,
    stateDir: paths.stateDir,
    runtimeDir: paths.runtimeDir,
    logDir: paths.logDir,
    cacheDir: paths.cacheDir,
    configFile: paths.configFile,
  };
};
