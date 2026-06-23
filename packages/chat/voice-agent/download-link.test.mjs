// download-link.test.mjs — the agent's createDownloadLinkFor capability: an agent can mint a working
// DOWNLOAD link (a web-key URL) for a file in its OWN home folder, to hand the user in a reply. Exercises
// the real chain makeFieldAgent → toolbox.createDownloadLinkFor → agent-home.downloadLink → download()
// minter → downloadFor (the lookup the /dl/<token> route uses). Asserts: a minted link resolves to the
// real file; the token is a 36-hex web-key (dodges the bare-32-hex trace scrub); a folder is refused; and a
// symlink planted in the home that points OUTSIDE is refused (no escaping the sandbox via the link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { makeFieldAgent } from './agent-caps.mjs';

test('download links survive a restart (the registry is persisted, not in-memory only)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-dl-persist-'));
  const fa1 = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid' });
  const { toolbox } = fa1.rootNode.toolbox();
  await toolbox.fileWrite.run({ path: 'doc.txt', content: 'PERSISTED-DOC' });
  const r = await toolbox.createDownloadLinkFor.run({ path: 'doc.txt', name: 'doc.txt' });
  assert.match(r.url, /^\/dl\/[0-9a-f]{36}$/);
  // a FRESH agent (== a service restart) over the SAME outDir must still resolve the token
  const fa2 = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid' });
  const rec = fa2.downloadFor(r.token);
  assert.ok(rec && rec.path, 'the link still resolves after a restart');
  assert.equal(fs.readFileSync(rec.path, 'utf8'), 'PERSISTED-DOC', 'and still serves the file');
});

const mkRoot = () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-dl-'));
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto-confirm.json'), specialistsFile: path.join(outDir, 'specialists.json') });
};

test('createDownloadLinkFor mints a /dl/<36hex> web-key that resolves to the real home file', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();
  const w = await toolbox.fileWrite.run({ path: 'reports/q3.txt', content: 'HELLO-DOWNLOAD' });
  assert.ok(w.ok, 'wrote the file into the agent home');

  const r = await toolbox.createDownloadLinkFor.run({ path: 'reports/q3.txt', name: 'q3.txt' });
  assert.match(r.url, /^\/dl\/[0-9a-f]{36}$/, `relative /dl web-key — got ${r.url}`);
  assert.equal(r.name, 'q3.txt');
  assert.equal(r.token.length, 36, '18-byte token = 36 hex chars');
  // 36-hex dodges the bare-swissnum scrub (\b[0-9a-f]{32}\b) — a download link is a legit render.
  assert.equal(r.token.replace(/\b[0-9a-f]{32}\b/g, '«x»'), r.token, 'token is NOT redacted by the 32-hex scrub');

  const rec = fa.downloadFor(r.token);
  assert.ok(rec && rec.path, 'downloadFor resolves the token (what the /dl route uses)');
  assert.equal(fs.readFileSync(rec.path, 'utf8'), 'HELLO-DOWNLOAD', 'the token serves the real file content');
  assert.equal(rec.name, 'q3.txt');
  assert.equal(fa.downloadFor('deadbeef'.repeat(5)), null, 'an unknown token resolves to nothing (404)');

  // the canonical served path stays inside the agent's home sandbox
  const homeRoot = path.dirname(path.dirname(rec.path));
  assert.ok(rec.path.startsWith(homeRoot + path.sep), 'served path is within the home folder');
});

test('createDownloadLinkFor refuses a folder and a symlink that escapes the home', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();
  const w = await toolbox.fileWrite.run({ path: 'a/keep.txt', content: 'x' });
  const homeRoot = path.dirname(path.dirname(fa.downloadFor((await toolbox.createDownloadLinkFor.run({ path: 'a/keep.txt' })).token).path));

  // a directory is not downloadable
  const dirRes = await toolbox.createDownloadLinkFor.run({ path: 'a' });
  assert.equal(dirRes.ok, false, 'a folder is refused');
  assert.match(dirRes.error, /file/i);

  // plant a symlink inside the home that points OUTSIDE it → the link must be refused
  const escape = path.join(homeRoot, 'escape.txt');
  let symlinked = false;
  try { fs.symlinkSync('/etc/hostname', escape); symlinked = true; } catch { /* no /etc/hostname or no symlink perm — skip */ }
  if (symlinked && fs.existsSync('/etc/hostname')) {
    const esc = await toolbox.createDownloadLinkFor.run({ path: 'escape.txt' });
    assert.equal(esc.ok, false, 'a symlink pointing outside the home is refused');
    assert.match(esc.error, /outside your home/i);
  }
});
