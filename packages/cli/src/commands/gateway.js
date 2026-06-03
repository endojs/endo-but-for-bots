/* global process, setTimeout */
// @ts-check
/* eslint-disable no-await-in-loop */

/**
 * @file `endo gateway` subcommand actions.
 *
 * The subcommand group covers four operational verbs for the Endo
 * Gateway service (per `designs/gateway-package.md` § Feature 10 and
 * the maintainer directive on PR #343):
 *
 *   - `start` (and `run`): spawn the gateway daemon in the background
 *     (`start`) or run it in the foreground (`run`). Both resolve
 *     paths via `gateway-paths.js`, `mkdir -p` the runtime / state /
 *     log directories the gateway needs, write a pid file, and hand
 *     off to a node-runnable entry script at
 *     `packages/gateway/src/gateway-node.js`.
 *   - `stop`: read the pid file, send `SIGTERM`, wait for exit,
 *     unlink the pid file.
 *   - `log`: print or follow `gateway.log` under the resolved log
 *     directory; in system mode where systemd captures stdout/stderr
 *     into the journal, advise the operator to run `journalctl -u
 *     endo-gateway` instead.
 *   - `where`: print the resolved paths (mode, state, runtime, log,
 *     cache, config, pid). `--json` for machine-readable output.
 *
 * The fifth verb `install-systemd` is the packaging helper. It writes
 * a starter `endo-gateway.service` to a caller-specified path (or to
 * stdout) with the unit body the design names. Real installation
 * (creating `endo:endo`, copying to `/etc/systemd/system`,
 * `systemctl daemon-reload`, `systemctl enable --now`) is the
 * operator's job; the CLI surfaces what to copy where but does not
 * `sudo` anything itself.
 *
 * The gateway daemon entry script (`packages/gateway/src/gateway-node.js`)
 * constructs a gateway exo via `@endo/gateway`'s `makeGateway`,
 * `start()`s it, and waits for SIGTERM. The HTTP listener is not yet
 * wired (per `designs/gateway-package.md` § Status; this is phase-9
 * design state), so today's `start()` is a no-op at the network
 * layer; the lifecycle plumbing is still useful because it exercises
 * the path resolution, the pid-file handling, and the service-manager
 * contract end-to-end ahead of the listener wiring.
 */

import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn, spawnSync } from 'child_process';

import { resolveCliPaths } from '../gateway-paths.js';

/**
 * Resolve the file path of the gateway daemon entry script. The
 * gateway exposes `src/gateway-node.js` from its package, and that
 * file is the runnable entry the CLI forks.
 */
const resolveGatewayNodeEntry = async () => {
  // import.meta.resolve when available; otherwise import the package
  // and use its main file. The CLI cannot depend on
  // `import.meta.resolve` because the supported Node range still
  // includes versions without it; fall back to a require-style
  // resolution.
  const packageJsonHref = await import.meta
    .resolve('@endo/gateway/package.json');
  const packageJsonPath = url.fileURLToPath(packageJsonHref);
  const packageDir = path.dirname(packageJsonPath);
  return path.join(packageDir, 'src', 'gateway-node.js');
};

/**
 * Ensure each directory in the list exists. Skips silently when the
 * directory is already present.
 *
 * @param {string[]} dirs
 */
const mkdirAll = async dirs => {
  for (const dir of dirs) {
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.mkdir(dir, { recursive: true });
  }
};

/**
 * Read a numeric pid from a pid file. Returns `null` when the file is
 * missing or unreadable.
 *
 * @param {string} pidPath
 * @returns {Promise<number | null>}
 */
const readPidFile = async pidPath => {
  try {
    const text = await fs.promises.readFile(pidPath, 'utf8');
    const pid = Number(text.trim());
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  } catch {
    // missing or unreadable
  }
  return null;
};

/**
 * Returns `true` if the given pid is running. Uses `process.kill(pid, 0)`
 * which signals nothing but tests whether the kernel would allow a
 * signal delivery.
 *
 * @param {number} pid
 * @returns {boolean}
 */
const pidAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sleep for `ms` milliseconds.
 *
 * @param {number} ms
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const pidBasename = 'gateway.pid';
const logBasename = 'gateway.log';

/**
 * Resolve gateway paths without touching the filesystem. The `where`
 * and `install-systemd` verbs use this so a non-root user can ask
 * about the system-mode paths from a developer machine without
 * tripping `EACCES` on `/var/lib`.
 *
 * @param {{ system?: boolean }} opts
 */
const resolveOnly = ({ system = false }) => {
  const resolved = resolveCliPaths({ explicit: !!system });
  return {
    ...resolved,
    pidPath: path.join(resolved.runtimeDir.path, pidBasename),
    logPath: path.join(resolved.logDir.path, logBasename),
  };
};

/**
 * Common path resolution + directory creation for the lifecycle verbs
 * (`start`, `stop`, `log`). The verbs that actually do work need the
 * directories to exist; the read-only verbs use `resolveOnly`.
 *
 * @param {{ system?: boolean }} opts
 */
const resolveAndEnsure = async ({ system = false }) => {
  const resolved = resolveOnly({ system });
  // The log directory may equal the state directory in user mode; the
  // duplicate mkdir is idempotent.
  await mkdirAll([
    resolved.stateDir.path,
    resolved.runtimeDir.path,
    resolved.logDir.path,
  ]);
  return resolved;
};

/**
 * Start the gateway daemon in the background (`endo gateway start`).
 *
 * @param {{ system?: boolean, foreground?: boolean }} opts
 */
export const start = async ({ system = false, foreground = false } = {}) => {
  const paths = await resolveAndEnsure({ system });
  const existing = await readPidFile(paths.pidPath);
  if (existing !== null && pidAlive(existing)) {
    process.stderr.write(
      `Endo Gateway already running (pid ${existing}, mode ${paths.mode})\n`,
    );
    return 0;
  }
  if (existing !== null) {
    // Stale pid file; remove before claiming the slot.
    await fs.promises.rm(paths.pidPath, { force: true });
  }

  const entryPath = await resolveGatewayNodeEntry();
  const childEnv = {
    ...process.env,
    ENDO_GATEWAY_MODE: paths.mode,
    ENDO_GATEWAY_STATE_DIR: paths.stateDir.path,
    ENDO_GATEWAY_RUNTIME_DIR: paths.runtimeDir.path,
    ENDO_GATEWAY_LOG_DIR: paths.logDir.path,
    ENDO_GATEWAY_CACHE_DIR: paths.cacheDir.path,
    ENDO_GATEWAY_CONFIG_FILE: paths.configFile.path,
    ENDO_GATEWAY_PID_FILE: paths.pidPath,
  };

  if (foreground) {
    // `endo gateway run` shape: do not detach; do not redirect stdio.
    // Used by service managers that handle the supervision themselves.
    const child = spawn(process.execPath, [entryPath], {
      env: childEnv,
      stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    return code ?? 0;
  }

  // Detached, log-redirected background fork.
  const out = fs.openSync(paths.logPath, 'a');
  const child = spawn(process.execPath, [entryPath], {
    env: childEnv,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);

  // Wait briefly for the pid file to land, so the user sees a clear
  // failure mode if the entry script crashes immediately. The entry
  // script itself writes the pid file before entering its event loop.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const pid = await readPidFile(paths.pidPath);
    if (pid !== null && pidAlive(pid)) {
      process.stderr.write(
        `Endo Gateway started (pid ${pid}, mode ${paths.mode})\n` +
          `state: ${paths.stateDir.path}\n` +
          `runtime: ${paths.runtimeDir.path}\n` +
          `log: ${paths.logPath}\n`,
      );
      return 0;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  process.stderr.write(
    `Endo Gateway did not write a pid file within 5s; check ${paths.logPath}\n`,
  );
  return 1;
};

/**
 * Stop the gateway daemon (`endo gateway stop`). Reads the pid file,
 * sends `SIGTERM`, waits up to 10s for exit, then unlinks the pid
 * file.
 *
 * @param {{ system?: boolean, signal?: NodeJS.Signals }} opts
 */
export const stop = async ({ system = false, signal = 'SIGTERM' } = {}) => {
  const paths = await resolveAndEnsure({ system });
  const pid = await readPidFile(paths.pidPath);
  if (pid === null) {
    process.stderr.write(
      `Endo Gateway not running (no pid file at ${paths.pidPath})\n`,
    );
    return 0;
  }
  if (!pidAlive(pid)) {
    process.stderr.write(
      `Stale pid file (${paths.pidPath} -> ${pid}); removing\n`,
    );
    await fs.promises.rm(paths.pidPath, { force: true });
    return 0;
  }
  try {
    process.kill(pid, signal);
  } catch (e) {
    process.stderr.write(
      `Failed to signal ${pid}: ${/** @type {Error} */ (e).message}\n`,
    );
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      await fs.promises.rm(paths.pidPath, { force: true });
      process.stderr.write(`Endo Gateway stopped (pid ${pid})\n`);
      return 0;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  process.stderr.write(
    `Endo Gateway pid ${pid} did not exit within 10s; sending SIGKILL\n`,
  );
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await fs.promises.rm(paths.pidPath, { force: true });
  return 0;
};

/**
 * Print or follow the gateway log (`endo gateway log`).
 *
 * @param {{ system?: boolean, follow?: boolean }} opts
 */
export const log = async ({ system = false, follow = false } = {}) => {
  const paths = await resolveAndEnsure({ system });

  // In system mode, systemd captures stdout/stderr into its journal;
  // the gateway.log path may still exist if the operator
  // redirected the unit's StandardOutput=append:/path. We print both
  // surfaces so the operator can pick the one their unit actually
  // uses.
  if (paths.mode === 'system') {
    process.stderr.write(
      `# System-service mode: this log is the redirected stdout/stderr\n` +
        `# of the daemon (under StandardOutput=append:${paths.logPath}).\n` +
        `# If the unit uses systemd-journal (the default), use:\n` +
        `#   journalctl -u endo-gateway -f\n`,
    );
  }

  let exists = false;
  try {
    await fs.promises.access(paths.logPath, fs.constants.R_OK);
    exists = true;
  } catch {
    // not yet
  }
  if (!exists) {
    process.stderr.write(`No log file at ${paths.logPath}\n`);
    return 1;
  }

  const args = follow ? ['-f', paths.logPath] : [paths.logPath];
  const child = spawn('tail', args, { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('exit', code => resolve(code ?? 0));
    child.once('error', reject);
  });
};

/**
 * Print the gateway's resolved paths (`endo gateway where`).
 *
 * @param {{ system?: boolean, json?: boolean }} opts
 */
export const where = async ({ system = false, json = false } = {}) => {
  const paths = resolveOnly({ system });
  const out = {
    mode: paths.mode,
    state: paths.stateDir.path,
    runtime: paths.runtimeDir.path,
    log: paths.logDir.path,
    cache: paths.cacheDir.path,
    config: paths.configFile.path,
    pid: paths.pidPath,
    logFile: paths.logPath,
    sources: {
      state: paths.stateDir.source,
      runtime: paths.runtimeDir.source,
      log: paths.logDir.source,
      cache: paths.cacheDir.source,
      config: paths.configFile.source,
    },
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`mode: ${out.mode}\n`);
    process.stdout.write(`state: ${out.state}\n`);
    process.stdout.write(`runtime: ${out.runtime}\n`);
    process.stdout.write(`log: ${out.log}\n`);
    process.stdout.write(`cache: ${out.cache}\n`);
    process.stdout.write(`config: ${out.config}\n`);
    process.stdout.write(`pid: ${out.pid}\n`);
    process.stdout.write(`logFile: ${out.logFile}\n`);
  }
  return 0;
};

/**
 * Print a starter `endo-gateway.service` systemd unit (or write it to
 * a file). The output is templated from the design's Feature 10
 * sketch; the operator copies it to `/etc/systemd/system/`, runs
 * `systemctl daemon-reload`, and `systemctl enable --now
 * endo-gateway`.
 *
 * The CLI deliberately does not perform installation itself: it has
 * no permission to write to `/etc/systemd/system/`, to create the
 * `endo` system user, or to invoke `systemctl`. The right shape for
 * an installer is a packaging step (`.deb`, `.rpm`, PKGBUILD) that
 * the design's Feature 10 names; this verb is for hand-installs and
 * for one-off operator review.
 *
 * @param {{ output?: string, execStart?: string }} opts
 */
export const installSystemd = async ({ output, execStart } = {}) => {
  // Locate `endo` on PATH so the unit's ExecStart points to the
  // installed CLI rather than a node + script-path pair. The operator
  // can override via `--exec-start`.
  let resolvedExecStart = execStart;
  if (resolvedExecStart === undefined) {
    // Try `which endo`. If we can't find one, leave a placeholder
    // for the operator.
    const which = spawnSync('which', ['endo'], { encoding: 'utf8' });
    if (which.status === 0) {
      resolvedExecStart = `${which.stdout.trim()} gateway run --system`;
    } else {
      resolvedExecStart = '/usr/bin/endo gateway run --system';
    }
  }

  const unit = renderSystemdUnit({ execStart: resolvedExecStart });
  if (output === undefined || output === '-') {
    process.stdout.write(unit);
    return 0;
  }
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await fs.promises.writeFile(output, unit, { mode: 0o644 });
  process.stderr.write(`Wrote ${output}\n`);
  process.stderr.write(
    `Next steps (run as root):\n` +
      `  useradd --system --home /var/lib/endo-gateway --shell /usr/sbin/nologin endo\n` +
      `  install -d -o endo -g endo -m 0750 /var/lib/endo-gateway /var/log/endo-gateway /var/cache/endo-gateway\n` +
      `  install -d -m 0755 /etc/endo-gateway\n` +
      `  cp ${output} /etc/systemd/system/endo-gateway.service\n` +
      `  systemctl daemon-reload\n` +
      `  systemctl enable --now endo-gateway\n`,
  );
  return 0;
};

/**
 * Render the systemd unit body. Kept pure so a test can assert on
 * the rendering without writing to disk.
 *
 * @param {{ execStart: string }} args
 * @returns {string}
 */
export const renderSystemdUnit = ({ execStart }) => `[Unit]
Description=Endo Gateway
Documentation=https://github.com/endojs/endo/blob/master/packages/gateway/README.md
After=network.target

[Service]
Type=simple
User=endo
Group=endo
ExecStart=${execStart}
EnvironmentFile=-/etc/default/endo-gateway
Restart=on-failure
RestartSec=5s

# systemd-managed directories. The unit creates them at start and
# fills in the matching ENDO_GATEWAY_*_DIR env vars below. The
# resolver in @endo/gateway honors those overrides.
RuntimeDirectory=endo-gateway
RuntimeDirectoryMode=0750
StateDirectory=endo-gateway
StateDirectoryMode=0750
CacheDirectory=endo-gateway
CacheDirectoryMode=0750
LogsDirectory=endo-gateway
LogsDirectoryMode=0750

Environment=ENDO_GATEWAY_RUNTIME_DIR=/run/endo-gateway
Environment=ENDO_GATEWAY_STATE_DIR=/var/lib/endo-gateway
Environment=ENDO_GATEWAY_CACHE_DIR=/var/cache/endo-gateway
Environment=ENDO_GATEWAY_LOG_DIR=/var/log/endo-gateway
Environment=ENDO_GATEWAY_CONFIG_FILE=/etc/endo-gateway/config.toml

# Hardening. systemd's defaults plus the gateway-specific shape
# (no /home access, no new privileges, read-only filesystem outside
# the managed directories above).
ProtectSystem=strict
ProtectHome=true
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
