// sites-persist.test.mjs — a published-site link (/sites/<token>) must survive a service restart. The site
// CONTENT lives under HOME_BASE (durable); the token→dir map used to be in-memory only, so every restart
// 404'd every prior /sites link ("unknown or revoked site"). This proves the map is now persisted: a token
// minted in one agent instance still resolves from a FRESH instance over the same outDir (== a restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { makeFieldAgent } from './agent-caps.mjs';

test('published sites survive a restart (the /sites token→dir map is persisted)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sites-'));
  const fa1 = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid' });
  const { toolbox } = fa1.rootNode.toolbox();
  await toolbox.fileWrite.run({ path: 'sitepersist-probe/index.html', content: '<h1>PROBE-SITE</h1>' });
  const r = await toolbox.publishSite.run({ path: 'sitepersist-probe', name: 'Probe' });
  assert.ok(r.token && r.url, 'publishSite returned a token + url');

  // a FRESH agent (== a service restart) over the SAME outDir must still resolve the token
  const fa2 = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid' });
  const dir = fa2.siteDir(r.token);
  assert.ok(dir, 'the published site still resolves after a restart (was "unknown or revoked site")');
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /PROBE-SITE/, 'and still serves its content');
  assert.equal(fa2.siteDir('deadbeefdeadbeef'), null, 'an unknown token still resolves to nothing');

  fs.rmSync(outDir, { recursive: true, force: true });
  try { fs.rmSync(path.join('/home/dan/.local/state/field-agent/home/root', 'sitepersist-probe'), { recursive: true, force: true }); } catch { /* */ }
});
