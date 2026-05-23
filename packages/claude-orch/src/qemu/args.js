// @ts-check
/**
 * @import {
 *   Arch,
 *   OrchestratorConfig,
 *   SessionRecord,
 * } from '../../protocol.types.js'
 */

import path from 'node:path';
import process from 'node:process';

/**
 * The chardev reconnect parameter is version-skewed across QEMU
 * releases. `reconnect=<seconds>` was deprecated in QEMU 9.2 and
 * removed in 10.0 — current Homebrew (10.2.x) refuses the old form
 * with `Invalid parameter 'reconnect'`. `reconnect-ms=<ms>` was
 * introduced in QEMU 9.0 and is the only supported spelling on
 * 10.x. Ubuntu 24.04 LTS still ships 8.2.2, which only knows the
 * legacy form. We emit the right one based on the detected major
 * version (see `detectQemuVersion` in `spawner.js`); when no
 * version is supplied we default to the modern form, which is
 * correct for the orchestrator's target platforms (modern Linux
 * distros + Homebrew on macOS).
 *
 * @param {{ major: number }} [qemuVersion]
 * @returns {string}
 */
const reconnectSpec = qemuVersion => {
  if (qemuVersion && qemuVersion.major < 9) {
    return 'reconnect=1';
  }
  return 'reconnect-ms=1000';
};

/**
 * Build the argv for `qemu-system-<arch>` for one session.
 *
 * Mirrors Appendix A of DESIGN.md. The argv is platform-dependent in two
 * places: the accelerator (`hvf` on darwin, `kvm` on linux) and the machine
 * type (`microvm` is x86_64-only; arm64 uses `virt`). Network args come
 * from the network controller (network/index.js) and are appended by the
 * caller.
 *
 * @param {{
 *   arch: Arch,
 *   record: SessionRecord,
 *   config: OrchestratorConfig,
 *   netArgs: readonly string[],
 *   qemuVersion?: { major: number },
 * }} opts
 * @returns {string[]}
 */
export const buildQemuArgs = ({
  arch,
  record,
  config,
  netArgs,
  qemuVersion,
}) => {
  const platform = process.platform;
  const accel = platform === 'darwin' ? 'hvf' : 'kvm';
  const machine =
    arch === 'x86_64'
      ? 'microvm,acpi=off,pic=off,pit=off,rtc=on'
      : 'virt,gic-version=3';
  const kernelImage =
    arch === 'x86_64'
      ? path.join(config.imageDir, 'vmlinux-x86_64')
      : path.join(config.imageDir, 'Image-arm64');
  const rootfsImage =
    arch === 'x86_64'
      ? path.join(config.imageDir, 'rootfs-x86_64.raw')
      : path.join(config.imageDir, 'rootfs-arm64.raw');

  const vcpus = record.request.resources?.vcpus ?? config.defaults.vcpus;
  const memMB = record.request.resources?.memMB ?? config.defaults.memMB;

  const blkDevice = arch === 'x86_64' ? 'virtio-blk-device' : 'virtio-blk-pci';
  const serialDevice =
    arch === 'x86_64' ? 'virtio-serial-device' : 'virtio-serial-pci';

  const args = [
    '-machine',
    machine,
    '-cpu',
    'host',
    '-accel',
    accel,
    '-smp',
    String(vcpus),
    '-m',
    String(memMB),
    '-nodefaults',
    '-no-user-config',
    '-no-reboot',
    '-kernel',
    kernelImage,
    '-append',
    [
      'console=hvc0',
      'root=/dev/vda',
      'ro',
      'rootfstype=ext4',
      'quiet',
      `claude.session_id=${record.id}`,
      `claude.boot_nonce=${record.bootNonce}`,
    ].join(' '),
    '-drive',
    `id=rootfs,file=${rootfsImage},format=raw,if=none,readonly=on`,
    '-device',
    `${blkDevice},drive=rootfs`,
    '-device',
    serialDevice,
    // ctl and agent chardevs run in *client* mode (server=off). The
    // orchestrator binds these UDS paths (`awaitHello` and
    // `makeAgentLink` call `server.listen`) before spawning QEMU; if
    // QEMU were configured with `server=on` here, both processes
    // would try to bind the same path and QEMU would fail with
    // EADDRINUSE. The reconnect knob lets the guest retry if the
    // orchestrator restarts and rebinds the socket. See
    // `reconnectSpec` for the QEMU-version handling; the same
    // pattern is mirrored in `scripts/smoke-boot.sh`.
    '-chardev',
    `socket,id=ctl,path=${record.ctlSocketPath},server=off,${reconnectSpec(qemuVersion)}`,
    '-device',
    'virtserialport,chardev=ctl,name=orchestrator',
    '-chardev',
    `socket,id=fs,path=${record.fsSocketPath},server=off,${reconnectSpec(qemuVersion)}`,
    '-device',
    'virtserialport,chardev=fs,name=workspace',
    '-chardev',
    `socket,id=agent,path=${record.agentSocketPath},server=off,${reconnectSpec(qemuVersion)}`,
    '-device',
    'virtserialport,chardev=agent,name=agent',
    '-chardev',
    `socket,id=stdio,path=${record.stdioSocketPath},server=on,wait=off`,
    '-device',
    'virtserialport,chardev=stdio,name=stdio',
    ...netArgs,
    '-qmp',
    `unix:${record.qmpSocketPath},server=on,wait=off`,
  ];
  return args;
};
harden(buildQemuArgs);

/**
 * Pick the QEMU binary name for the requested arch.
 *
 * @param {Arch} arch
 * @returns {string}
 */
export const qemuBinaryFor = arch =>
  arch === 'x86_64' ? 'qemu-system-x86_64' : 'qemu-system-aarch64';
harden(qemuBinaryFor);

/**
 * Derive a stable MAC from a session id. Locally administered, unicast.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export const deriveMac = sessionId => {
  // 02:<6 hex from session id>
  const hex = sessionId
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 10)
    .padEnd(10, '0');
  return `02:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}`;
};
harden(deriveMac);
