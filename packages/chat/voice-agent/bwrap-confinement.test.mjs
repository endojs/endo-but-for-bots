// bwrap-confinement.test.mjs — proves the worktree executor's host shell is a KERNEL boundary, not just a
// cwd default: bind only the worktree (rw) + a read-only toolchain/repo, DENY the rest of the host. Runs the
// command EXACTLY as host.exec builds it (jail = the worktree). Skips gracefully where bwrap can't run
// (e.g. nested inside another sandbox), since the boundary is still enforced at runtime by host.exec.
//
//   node --test packages/chat/voice-agent/bwrap-confinement.test.mjs
import '@endo/init';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BWRAP_BASE, BWRAP_BIN, WORKTREE_BWRAP } from './agent-caps.mjs';

const pexec = promisify(execFile);
// run a command in the bwrap sandbox EXACTLY as host.exec does (jail bound rw at its absolute path).
const sandboxed = async (jail, cmd) => {
  const args = [...BWRAP_BASE, '--bind', jail, jail, '--chdir', jail, '--', 'bash', '-lc', cmd];
  try { const { stdout, stderr } = await pexec(BWRAP_BIN, args, { timeout: 60000 }); return { ok: true, out: `${stdout}${stderr}` }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, code: e.code }; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-test-'));
const jail = path.join(tmp, 'wt'); fs.mkdirSync(jail);
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// can bwrap actually run here? (false when nested in another unprivileged sandbox → skip the boundary tests)
const smoke = WORKTREE_BWRAP ? await sandboxed(jail, 'echo READY') : { ok: false, out: '' };
const live = smoke.ok && /READY/.test(smoke.out);
const skip = live ? false : 'bwrap cannot run in this environment (no bin / nested sandbox) — boundary still enforced at runtime';

test('bwrap is the configured worktree confinement (binary present + WORKTREE_BWRAP on)', () => {
  assert.ok(BWRAP_BIN, 'a bwrap binary was found');
  assert.ok(WORKTREE_BWRAP, 'WORKTREE_BWRAP is enabled (worktree shells are kernel-confined)');
});

test('the confined shell CAN edit its worktree', { skip }, async () => {
  const r = await sandboxed(jail, 'echo hello > note.txt && cat note.txt');
  assert.ok(r.ok && /hello/.test(r.out), 'wrote + read inside the worktree');
  assert.ok(fs.existsSync(path.join(jail, 'note.txt')), 'the write landed in the REAL worktree');
});

test('the confined shell CANNOT read host secrets (~/.ssh, ~/.env, ~/.config)', { skip }, async () => {
  const r = await sandboxed(jail, 'cat /home/dan/.ssh/id_ed25519 2>&1; cat /home/dan/.env 2>&1; ls /home/dan/.config 2>&1');
  assert.doesNotMatch(r.out, /PRIVATE KEY|BEGIN OPENSSH|ANTHROPIC|sk-ant|api[_-]?key/i, 'no secret leaked');
  assert.match(r.out, /No such file|cannot access|not found/i, 'the secret paths are absent in the sandbox');
});

test('the confined shell CANNOT write outside its worktree (live repo / home stay intact)', { skip }, async () => {
  await sandboxed(jail, 'touch /home/dan/endo-bfb-llm/_bwrap_pwn 2>&1; touch /home/dan/_bwrap_pwn 2>&1');
  assert.ok(!fs.existsSync('/home/dan/endo-bfb-llm/_bwrap_pwn'), 'the live repo was NOT written');
  assert.ok(!fs.existsSync('/home/dan/_bwrap_pwn'), 'home was NOT written');
});

test('the confined shell has NO network egress', { skip }, async () => {
  const r = await sandboxed(jail, 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/53" 2>&1; echo "rc=$?"');
  assert.doesNotMatch(r.out, /rc=0(\D|$)/, 'opening a TCP socket did NOT succeed (network is unshared)');
});
