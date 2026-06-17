// @ts-nocheck
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';

import { buildQemuArgs, deriveMac, qemuBinaryFor } from '../src/qemu/args.js';

const baseConfig = {
  socketPath: '/x',
  imageDir: '/images',
  sessionDir: '/sessions',
  brokerSocketPath: '/x',
  defaults: { arch: 'x86_64', vcpus: 4, memMB: 4096 },
  bootDeadlineMs: 30000,
  heartbeatTimeoutMs: 60000,
};

const baseRecord = {
  id: 'abc1234567890ab',
  state: 'pending',
  request: { network: 'egress', attachMode: 'stream' },
  bootNonce: 'a'.repeat(64),
  bootNonceUsed: false,
  sessionDir: '/sessions/abc',
  fsSocketPath: '/sessions/abc/fs.sock',
  ctlSocketPath: '/sessions/abc/ctl.sock',
  agentSocketPath: '/sessions/abc/agent.sock',
  stdioSocketPath: '/sessions/abc/stdio.sock',
  qmpSocketPath: '/sessions/abc/qmp.sock',
  attachSocketPath: '/sessions/abc/attach.sock',
  createdAt: '2026-05-15T00:00:00Z',
};

test('buildQemuArgs emits the chardev/virtserialport quartet from Appendix A', t => {
  const args = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: ['-netdev', 'foo', '-device', 'bar'],
  });
  const j = args.join(' ');
  // ctl, fs, and agent chardevs all run in client mode — the
  // orchestrator binds these UDS paths. stdio runs in server mode
  // because the stdio mux opens the connection to QEMU.
  t.regex(
    j,
    /-chardev socket,id=ctl,path=\/sessions\/abc\/ctl\.sock,server=off,reconnect-ms=1000/,
  );
  t.regex(
    j,
    /-chardev socket,id=fs,path=\/sessions\/abc\/fs\.sock,server=off,reconnect-ms=1000/,
  );
  t.regex(
    j,
    /-chardev socket,id=agent,path=\/sessions\/abc\/agent\.sock,server=off,reconnect-ms=1000/,
  );
  t.regex(
    j,
    /-chardev socket,id=stdio,path=\/sessions\/abc\/stdio\.sock,server=on,wait=off/,
  );
  t.regex(j, /virtserialport,chardev=ctl,name=orchestrator/);
  t.regex(j, /virtserialport,chardev=fs,name=workspace/);
  t.regex(j, /virtserialport,chardev=agent,name=agent/);
  t.regex(j, /virtserialport,chardev=stdio,name=stdio/);
  t.regex(j, /-qmp unix:\/sessions\/abc\/qmp\.sock/);
  t.true(args.includes('-netdev'));
});

test('buildQemuArgs threads the boot nonce and session id onto the cmdline', t => {
  const args = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
  });
  const append = args[args.indexOf('-append') + 1];
  t.regex(append, /claude\.session_id=abc1234567890ab/);
  t.regex(append, /claude\.boot_nonce=a{64}/);
});

test('buildQemuArgs selects machine type and devices per arch', t => {
  const x86 = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
  }).join(' ');
  const arm = buildQemuArgs({
    arch: 'aarch64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
  }).join(' ');
  t.regex(x86, /microvm,acpi=off,pic=off,pit=off,rtc=on/);
  t.regex(arm, /virt,gic-version=3/);
  t.regex(x86, /virtio-blk-device,drive=rootfs/);
  t.regex(arm, /virtio-blk-pci,drive=rootfs/);
});

test('qemuBinaryFor picks the right binary', t => {
  t.is(qemuBinaryFor('x86_64'), 'qemu-system-x86_64');
  t.is(qemuBinaryFor('aarch64'), 'qemu-system-aarch64');
});

test('deriveMac produces a 02:.. locally-administered unicast MAC', t => {
  const mac = deriveMac('abc1234567890def');
  t.regex(mac, /^02:[0-9a-f]{2}(:[0-9a-f]{2}){4}$/);
  t.is(deriveMac('abc1234567890def'), deriveMac('abc1234567890def'));
});

/**
 * Extract chardev specs (`-chardev socket,id=...,...`) from the argv
 * and return a map keyed by chardev id with the parsed mode flags
 * the test cares about (`server`, `reconnect`, `wait`).
 *
 * @param {string[]} args
 * @returns {Record<string, Record<string, string>>}
 */
const parseChardevs = args => {
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (flag === '-chardev') {
      const spec = String(args[i + 1] || '');
      if (spec.startsWith('socket,')) {
        /** @type {Record<string, string>} */
        const kv = {};
        for (const part of spec.split(',')) {
          const eq = part.indexOf('=');
          if (eq < 0) {
            kv[part] = '';
          } else {
            kv[part.slice(0, eq)] = part.slice(eq + 1);
          }
        }
        if (kv.id) out[kv.id] = kv;
      }
    }
  }
  return out;
};

// Each chardev that QEMU exposes has a fixed orchestrator-side role,
// because the orchestrator opens these UDS endpoints from specific
// modules. When the chardev's `server=` mode disagrees with the
// orchestrator's role, both processes end up calling `bind(2)` on the
// same path and the second loses with EADDRINUSE. (PR #328 Copilot
// review caught this for `ctl` and `agent`.) This invariant pins it
// per-chardev so future drift fails fast.
//
//   id     | orchestrator role | required chardev mode
//   ─────  │ ────────────────  │ ─────────────────────
//   ctl    │ server            │ server=off,reconnect-ms=1000
//   fs     │ server            │ server=off,reconnect-ms=1000
//   agent  │ server            │ server=off,reconnect-ms=1000
//   stdio  │ client            │ server=on
const CHARDEV_ROLES = harden({
  ctl: 'orchestrator-server',
  fs: 'orchestrator-server',
  agent: 'orchestrator-server',
  stdio: 'orchestrator-client',
});

test('chardev modes are compatible with orchestrator role (no double-bind)', t => {
  const args = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
  });
  const chardevs = parseChardevs(args);
  for (const [id, role] of Object.entries(CHARDEV_ROLES)) {
    const spec = chardevs[id];
    t.truthy(spec, `chardev id=${id} missing from buildQemuArgs output`);
    if (role === 'orchestrator-server') {
      // Orchestrator already calls server.listen(<path>); QEMU must
      // be the client, otherwise QEMU's bind(2) collides with the
      // orchestrator's bound socket and the VM fails to start.
      t.is(
        spec.server,
        'off',
        `chardev id=${id} expects server=off (orchestrator binds), got server=${spec.server}`,
      );
      t.is(
        spec['reconnect-ms'],
        '1000',
        `chardev id=${id} expects reconnect-ms=1000 so the guest retries after an orchestrator restart`,
      );
    } else {
      // Orchestrator (stdio mux) connects to QEMU's chardev; QEMU
      // must be the server.
      t.is(
        spec.server,
        'on',
        `chardev id=${id} expects server=on (orchestrator connects), got server=${spec.server}`,
      );
    }
  }
});

// The chardev `reconnect` knob changed spelling between QEMU
// releases: `reconnect=<seconds>` was deprecated in 9.2 and removed
// in 10.0; `reconnect-ms=<ms>` was added in 9.0 and is the only
// form modern (Homebrew, current Fedora, etc.) QEMU accepts.
// Ubuntu 24.04 LTS still ships 8.2.2 which only knows the legacy
// form. `buildQemuArgs` picks the right one from the optional
// `qemuVersion` opt; `spawnVm` populates it from `detectQemuVersion`
// at spawn time.
test('buildQemuArgs emits legacy reconnect=N when qemuVersion.major < 9', t => {
  const args = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
    qemuVersion: { major: 8, minor: 2, patch: 2 },
  }).join(' ');
  t.regex(args, /server=off,reconnect=1/);
  t.notRegex(args, /reconnect-ms/);
});

test('buildQemuArgs emits reconnect-ms=N when qemuVersion.major >= 9 (and by default)', t => {
  const argsModern = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
    qemuVersion: { major: 10, minor: 2, patch: 0 },
  }).join(' ');
  t.regex(argsModern, /server=off,reconnect-ms=1000/);
  t.notRegex(argsModern, /,reconnect=/);

  const argsDefault = buildQemuArgs({
    arch: 'x86_64',
    record: baseRecord,
    config: baseConfig,
    netArgs: [],
  }).join(' ');
  t.regex(argsDefault, /server=off,reconnect-ms=1000/);
});
