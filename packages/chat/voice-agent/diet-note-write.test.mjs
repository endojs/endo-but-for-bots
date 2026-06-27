// diet-note-write.test.mjs — the Dietician can now RECORD findings INTO the diet notes (not just read).
// appendDietNote fires immediately (non-destructive) and is JAILED to the Dietician/ folder; a path outside
// it is rejected and untouched. (OBSIDIAN_VAULT is read at agent-caps module load, so we set it before a
// dynamic import.)
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

test('the Dietician RECORDS into diet notes (appendDietNote), jailed to Dietician/', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-vault-'));
  fs.mkdirSync(path.join(vault, 'Dietician'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Dietician', 'Alexa — Diet.md'), '# Alexa Diet\nlow FODMAP\n');
  fs.mkdirSync(path.join(vault, 'Personal'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Personal', 'secret.md'), '# Secret\n');
  process.env.OBSIDIAN_VAULT = vault;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-out-'));
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json');
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'spec.json') });
  const { toolbox } = fa.rootNode.toolbox();
  try {
    assert.ok(toolbox.appendDietNote, 'appendDietNote is wired — the Dietician can write diet notes');
    assert.ok(toolbox.proposeDietNoteEdit, 'proposeDietNoteEdit is wired (confirm-gated overwrite)');

    // RECORD a finding into a Dietician note → immediate + non-destructive
    const r = await toolbox.appendDietNote.run({ path: 'Dietician/Alexa — Diet.md', content: 'reacts to corn — she suspects the sorbitol' });
    assert.ok(r.ok && r.appended, `append succeeds immediately — got ${JSON.stringify(r)}`);
    const c = fs.readFileSync(path.join(vault, 'Dietician', 'Alexa — Diet.md'), 'utf8');
    assert.match(c, /low FODMAP/, 'the original spec is preserved (non-destructive)');
    assert.match(c, /reacts to corn/, 'the new finding is recorded into the spec');

    // a path OUTSIDE Dietician/ is REJECTED (the write is jailed to the diet folder)
    const bad = await toolbox.appendDietNote.run({ path: 'Personal/secret.md', content: 'leak' });
    assert.equal(bad.ok, false, 'writing outside Dietician/ is rejected');
    assert.match(fs.readFileSync(path.join(vault, 'Personal', 'secret.md'), 'utf8'), /^# Secret\n$/, 'the outside note is untouched');

    // overwrite is PROPOSE-gated (does not write directly)
    const pe = await toolbox.proposeDietNoteEdit.run({ path: 'Dietician/Alexa — Diet.md', content: 'rewritten', mode: 'overwrite' });
    assert.ok(pe && (pe.proposed || pe.ok !== false), 'proposeDietNoteEdit mints a proposal (confirm-gated)');
    assert.doesNotMatch(fs.readFileSync(path.join(vault, 'Dietician', 'Alexa — Diet.md'), 'utf8'), /^rewritten$/, 'overwrite did NOT write before confirmation');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  }
});
