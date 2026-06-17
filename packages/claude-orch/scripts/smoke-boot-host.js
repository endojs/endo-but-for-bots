// @ts-nocheck
/* eslint-disable import/order */
/* global process, setTimeout */
//
// Host-side responder for `scripts/smoke-boot.sh`.
//
// Replaces the previous inline Node heredoc that rolled its own 9P
// responder. We now use the real `@endo/claude-container` 9P
// bridge (closing R1) backed by an `@endo/endo-fs` in-memory
// `Filesystem` populated with a single greeting file. The kernel
// inside QEMU mounts the bridge via 9P-trans=fd through the
// socketpair relay (see bootstrap-init).
//
// argv:
//   smoke-boot-host.js <BUILD_DIR> <hello-out> <ready-out> [<logs-out>] [<guest-write-out>]
//
// Writes `hello.json` when ctl.sock receives a Hello; writes
// `agent-ready.json` when agent.sock receives a Ready; and (when
// `<logs-out>` is provided) appends every Agent `Log` frame to
// that file as NDJSON.
//
// When the agent emits its `probe: workspace wrote …` log line —
// signalling that the guest has finished writing to
// `/workspace/guest-wrote.txt` via the 9P mount — and
// `<guest-write-out>` is provided, the host responder re-reads the
// file through the in-process endo-fs cap and writes a marker line
// to `<guest-write-out>` (`ok: <contents>` on match, `mismatch: …`
// otherwise). The shell driver greps that file to decide whether
// the guest → 9P → bridge → endo-fs write path actually delivered
// the bytes — the read-only smoke probe doesn't cover this
// direction.
//
// Exits 0 after 30s no matter what — the shell script reads those
// files to decide PASS/FAIL.

import '@endo/init/debug.js';

import net from 'node:net';
import fs from 'node:fs';

import { E } from '@endo/eventual-send';

import { makeInMemoryFilesystem } from '@endo/endo-fs/src/in-memory.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { makeFsBridge9p } from '@endo/9p-server';

const [, , dir, helloFile, readyFile, logsFile, guestWriteFile] = process.argv;
if (!dir || !helloFile || !readyFile) {
  console.error(
    'usage: smoke-boot-host.js <BUILD_DIR> <hello-out> <ready-out> [<logs-out>] [<guest-write-out>]',
  );
  process.exit(2);
}

// ---------- workspace FS ----------
//
// Populate a tiny in-memory endo-fs Filesystem with content the
// guest can read via 9P. The bridge below serves this FS to QEMU's
// 9P chardev.
const workspaceFs = makeInMemoryFilesystem();

const populate = async () => {
  const root = await E(workspaceFs).root();
  const greet = await E(root).create('hello.txt', {});
  const w = iterateBytesWriter(await E(greet).write(0n));
  await w.next(new TextEncoder().encode('hello from endo-fs\n'));
  await w.return();
  await E(greet).close();
};

const main = async () => {
  await populate();

  // ---------- ctl.sock: receive Hello, send BootConfig ----------
  net
    .createServer(conn => {
      let buf = '';
      conn.on('data', d => {
        buf += d.toString('utf8');
        const i = buf.indexOf('\n');
        if (i >= 0) {
          fs.writeFileSync(helloFile, buf.slice(0, i));
          conn.write(
            `${JSON.stringify({
              type: 'boot_config',
              credentials: { apiKey: 'k' },
              fsMountTag: 'workspace',
              workspaceUidGid: [1000, 1000],
              envExtra: {},
              agentControlPort: 'agent',
            })}\n`,
          );
        }
      });
      conn.on('error', () => {});
    })
    .listen(`${dir}/ctl.sock`);

  // ---------- fs.sock: real 9P bridge over endo-fs ----------
  const bridge = makeFsBridge9p({
    fs: workspaceFs,
    socketPath: `${dir}/fs.sock`,
  });
  await E(bridge).start();

  const expectedGuestWrite = 'bytes written by the runtime-agent';

  // Pull `/workspace/guest-wrote.txt` back off the endo-fs cap to
  // confirm the guest's 9P-write reached the underlying Filesystem
  // (not just the bridge's in-memory state).
  const verifyGuestWrite = async () => {
    if (!guestWriteFile) return;
    try {
      const root = await E(workspaceFs).root();
      const f = await E(root).lookup('guest-wrote.txt');
      const oh = await E(f).open({});
      let total = new Uint8Array(0);
      for await (const chunk of iterateBytesReader(
        await E(oh).read(0n, BigInt(expectedGuestWrite.length)),
      )) {
        const next = new Uint8Array(total.length + chunk.length);
        next.set(total, 0);
        next.set(chunk, total.length);
        total = next;
      }
      await E(oh).close();
      const decoded = new TextDecoder().decode(total);
      if (decoded === expectedGuestWrite) {
        fs.writeFileSync(guestWriteFile, `ok: ${decoded}\n`);
      } else {
        fs.writeFileSync(
          guestWriteFile,
          `mismatch: expected ${JSON.stringify(expectedGuestWrite)} got ${JSON.stringify(decoded)}\n`,
        );
      }
    } catch (e) {
      fs.writeFileSync(
        guestWriteFile,
        `missing: ${(e && e.message) || String(e)}\n`,
      );
    }
  };

  // ---------- agent.sock: receive Ready + Log probes ----------
  if (logsFile) {
    // Reset the logs file at startup so an old run's data doesn't
    // contaminate the next.
    fs.writeFileSync(logsFile, '');
  }
  net
    .createServer(c => {
      let buf = '';
      c.on('data', d => {
        buf += d.toString('utf8');
        let i;
        // eslint-disable-next-line no-cond-assign
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'ready') {
              fs.writeFileSync(readyFile, JSON.stringify(msg));
            } else if (msg.type === 'log' && logsFile) {
              // NDJSON so the shell script can grep line-by-line.
              fs.appendFileSync(logsFile, `${JSON.stringify(msg)}\n`);
              // The runtime-agent's write-probe log line is the
              // signal that the guest is done writing. Fire the
              // host-side re-read once we see it.
              if (
                typeof msg.msg === 'string' &&
                msg.msg.startsWith(
                  'probe: workspace wrote /workspace/guest-wrote.txt',
                )
              ) {
                verifyGuestWrite().catch(e =>
                  console.error('[smoke-boot-host] verify failed', e),
                );
              }
            }
          } catch {
            // ignore non-JSON
          }
        }
      });
      c.on('error', () => {});
    })
    .listen(`${dir}/agent.sock`);

  console.log('[smoke-boot-host] listening on ctl/fs/agent sockets');
};

main().catch(e => {
  console.error('[smoke-boot-host] fatal', e);
  process.exit(1);
});

// Self-terminate after 30s — the shell script reads the output
// files; this process should not outlive QEMU.
setTimeout(() => process.exit(0), 30000);
