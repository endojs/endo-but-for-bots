// @ts-check
/* global process */

/**
 * Daemon control entry point: a tiny SES-locked-down helper that the
 * Electron main process spawns to issue a single CapTP-mediated control
 * call against the running Endo daemon.
 *
 * Consolidates the previously bundled `endo-cli.cjs` surfaces
 * (`endo stop`, `endo purge`) into one entry point parameterized by an
 * argv method name, so the Electron-main side passes a single command
 * string rather than reproducing per-CLI-subcommand argument shapes.
 *
 * The control verb (the first argv after `--`) names one of the
 * lifecycle methods re-exported by `@endo/daemon`:
 *
 *   - `stop`    drains the daemon via `E(bootstrap).terminate()`,
 *               kills the daemon process, sweeps worker pid files,
 *               and removes the socket plus pid file.
 *   - `purge`   does the `stop` sequence, then removes the persistent
 *               state, ephemeral state, and cache directories.
 *   - `restart` runs `stop` then re-launches the daemon.
 *
 * The CapTP shape is identical for `stop` and `purge`: a single
 * `E(bootstrap).terminate()` send against the daemon's harbinger
 * bootstrap (see `packages/daemon/index.js` `terminate()`), followed
 * by a graceful close of the netstring-framed Unix-socket connection.
 *
 * Lockdown via `@endo/init` runs **inside this subprocess only**, so
 * the Electron main process stays unlocked (Electron internals would
 * break under SES). The Electron main consumes the control verb's
 * exit code as success / failure.
 */

import '@endo/init';

import { stop, purge, restart } from '@endo/daemon';

const main = async () => {
  await null;
  const [verb] = process.argv.slice(2);
  if (verb === 'stop') {
    await stop();
  } else if (verb === 'purge') {
    await purge();
  } else if (verb === 'restart') {
    await restart();
  } else {
    throw new Error(
      `daemon-control: unknown verb ${JSON.stringify(verb)}; expected one of stop, purge, restart`,
    );
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
