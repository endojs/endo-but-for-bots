// notes-traversal.test.mjs — regression proof that the notes-scope guard (underPrefix) is escape-proof.
//
// The hole (fixed, agent-caps.mjs): underPrefix was a raw string-prefix test, but read/write resolves with
// path.resolve (which collapses `..`). So "Dietician/../Personal/secret.md" passed the `Dietician/` check
// and then escaped the scope. Now underPrefix canonicalizes (resolve-then-contain) before checking.
//
// Layer 1: a pure unit test of the exported guard. Layer 2: the REAL Dietician toolbox (appendDietNote /
// readDietNote), proving the escape is refused end-to-end and the out-of-scope secret is untouched.
//
// Run: node --test notes-traversal.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { underPrefix } from './agent-caps.mjs';

test('underPrefix: `..` traversal out of the scope is refused', () => {
  assert.equal(underPrefix('Dietician/notes.md', 'Dietician'), true, 'a genuine in-scope path passes');
  assert.equal(underPrefix('Dietician', 'Dietician'), true, 'the scope root itself passes');
  assert.equal(underPrefix('Dietician/sub/deep.md', 'Dietician'), true, 'a nested in-scope path passes');
  assert.equal(underPrefix('Dietician/../Personal/secret.md', 'Dietician'), false, 'a `..` escape is refused');
  assert.equal(underPrefix('Dietician/../../etc/passwd', 'Dietician'), false, 'a double `..` escape is refused');
  assert.equal(underPrefix('../outside.md', 'Dietician'), false, 'a leading `..` is refused');
  assert.equal(underPrefix('DieticianX/notes.md', 'Dietician'), false, 'a sibling prefix (Dietician vs DieticianX) is refused');
  assert.equal(underPrefix('anything', ''), true, 'an empty prefix = whole vault');
  assert.equal(underPrefix('../escape', ''), false, 'even with no prefix, escaping the vault root is refused');
});

test('the real Dietician toolbox refuses a `..` traversal write, keeps in-scope writes working', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-vault-'));
  fs.mkdirSync(path.join(vault, 'Dietician'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Dietician', 'Alexa — Diet.md'), '# Alexa Diet\nlow FODMAP\n');
  fs.mkdirSync(path.join(vault, 'Personal'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Personal', 'secret.md'), '# Secret\n');
  process.env.OBSIDIAN_VAULT = vault;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-out-'));
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json');
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'spec.json') });
  const { toolbox } = fa.rootNode.toolbox();

  // a legitimate in-scope append still works
  const ok = await toolbox.appendDietNote.run({ path: 'Dietician/Alexa — Diet.md', content: 'reacts to corn' });
  assert.ok(ok.ok && ok.appended, `in-scope append works — got ${JSON.stringify(ok)}`);

  // the `..` escape to Personal/secret.md is REFUSED and the secret is untouched
  const escape = await toolbox.appendDietNote.run({ path: 'Dietician/../Personal/secret.md', content: 'LEAK' });
  assert.equal(escape.ok, false, 'a `..` traversal write must be refused');
  assert.equal(fs.readFileSync(path.join(vault, 'Personal', 'secret.md'), 'utf8'), '# Secret\n', 'the out-of-scope note is untouched');

  // reading via a `..` traversal is refused too
  const readEscape = await toolbox.readDietNote.run({ path: 'Dietician/../Personal/secret.md' });
  assert.ok(!readEscape || readEscape.ok === false || !/Secret/.test(JSON.stringify(readEscape)), `a \`..\` traversal read must not leak the secret — got ${JSON.stringify(readEscape)}`);
});
