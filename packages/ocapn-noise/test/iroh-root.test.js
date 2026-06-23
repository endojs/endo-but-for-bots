// @ts-nocheck
// iroh-root.test.js — the deployable iroh-root.mjs is the migration template: a real ocapn-noise root node
// that serves over Iroh with NO open TCP port. This spawns it as a real OS process and asserts the headline
// adoption win directly: (1) it comes up and advertises an Ed25519 EndpointId (dial-by-key), and (2) `ss`
// shows the process has ZERO TCP listeners — the open-LAN-port surface is genuinely gone. (The full
// ocap/CapTP round-trip over the same transport is proven in iroh-captp.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'iroh-root.mjs');

test('iroh-root.mjs serves over iroh with NO open TCP port (dial-by-EndpointId)', { timeout: 30000 }, async () => {
  const proc = spawn('node', [ROOT, '--preset', 'minimal'], { cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('iroh-root did not print dial info in time')), 20000);
      proc.stdout.on('data', d => {
        buf += String(d);
        const line = buf.split('\n').find(l => l.trim().startsWith('{'));
        if (line) { clearTimeout(to); try { resolve(JSON.parse(line)); } catch (e) { reject(e); } }
      });
      proc.on('exit', c => { clearTimeout(to); reject(new Error(`iroh-root exited early (${c})`)); });
    });

    assert.match(String(info.endpointId || ''), /^[0-9a-f]{64}$/i, `advertises a 32-byte Ed25519 EndpointId — got ${info.endpointId}`);
    assert.match(String(info.keyId || ''), /^[0-9a-f]{64}$/i, 'advertises a noise keyId designator');
    assert.equal(info.location?.hints?.['tcp:port'], undefined, 'location carries NO tcp:port');
    assert.ok(info.location?.hints?.['iroh:id'], 'location carries an iroh:id hint');

    // The headline: this PID has zero TCP listeners (only QUIC/UDP). ss output lists socket states + the pid.
    let ss = '';
    try { ss = execFileSync('ss', ['-tlnH', '-p'], { encoding: 'utf8' }); } catch { /* ss absent → skip the OS assertion */ }
    if (ss) {
      const tcpListenersForPid = ss.split('\n').filter(l => l.includes(`pid=${proc.pid},`) || l.includes(`pid=${proc.pid} `));
      assert.equal(tcpListenersForPid.length, 0, `iroh-root must have NO open TCP listener — found: ${tcpListenersForPid.join(' | ')}`);
    }
  } finally {
    proc.kill('SIGKILL');
  }
});
