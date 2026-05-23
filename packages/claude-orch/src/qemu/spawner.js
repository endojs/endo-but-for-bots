// @ts-check
/**
 * @import {
 *   Arch,
 *   OrchestratorConfig,
 *   SessionRecord,
 * } from '../../protocol.types.js'
 * @import { ChildProcess } from 'node:child_process'
 */

import { spawn, spawnSync } from 'node:child_process';

import { buildQemuArgs, qemuBinaryFor } from './args.js';

/**
 * @typedef {object} VmHandle
 * @property {ChildProcess} child
 * @property {Promise<number>} exitCode
 * @property {(signal?: NodeJS.Signals) => void} kill
 */

/**
 * Parse the first line of `qemu-system-<arch> --version` output,
 * which looks like one of:
 *   "QEMU emulator version 10.2.0"
 *   "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.16)"
 * Returns `undefined` if the line can't be parsed; callers fall
 * back to the modern QEMU defaults in that case.
 *
 * @param {string} stdout
 * @returns {{ major: number, minor: number, patch: number } | undefined}
 */
export const parseQemuVersion = stdout => {
  const m = stdout.match(/version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return harden({
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  });
};
harden(parseQemuVersion);

/** @type {Map<string, { major: number, minor: number, patch: number } | undefined>} */
const qemuVersionCache = new Map();

/**
 * Detect the installed QEMU version once per binary path. Result
 * is cached for the process lifetime.
 *
 * @param {string} binary
 * @returns {{ major: number, minor: number, patch: number } | undefined}
 */
export const detectQemuVersion = binary => {
  if (qemuVersionCache.has(binary)) {
    return qemuVersionCache.get(binary);
  }
  try {
    const r = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const version =
      r.status === 0 ? parseQemuVersion(String(r.stdout)) : undefined;
    qemuVersionCache.set(binary, version);
    return version;
  } catch {
    qemuVersionCache.set(binary, undefined);
    return undefined;
  }
};
harden(detectQemuVersion);

/**
 * Spawn QEMU for a session.
 *
 * The QEMU process inherits stderr (so kernel/QEMU diagnostics appear in
 * the orchestrator log) but its stdout is dropped — the kernel console
 * goes to hvc0 which we don't attach to the parent. If the process needs
 * to be debugged, hook a console chardev from the API.
 *
 * @param {{
 *   arch: Arch,
 *   record: SessionRecord,
 *   config: OrchestratorConfig,
 *   netArgs: readonly string[],
 * }} opts
 * @returns {VmHandle}
 */
export const spawnVm = ({ arch, record, config, netArgs }) => {
  const binary = qemuBinaryFor(arch);
  const qemuVersion = detectQemuVersion(binary);
  const args = buildQemuArgs({ arch, record, config, netArgs, qemuVersion });

  const child = spawn(binary, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });

  const exitCode = /** @type {Promise<number>} */ (
    new Promise(resolve => {
      child.once('exit', code => resolve(typeof code === 'number' ? code : -1));
    })
  );

  return harden({
    child,
    exitCode,
    kill: (signal = 'SIGTERM') => {
      if (!child.killed) child.kill(signal);
    },
  });
};
harden(spawnVm);
