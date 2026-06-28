// fold-docs.test.mjs — the reusable "documents always on hand" pattern: an agent's standing reference docs are
// read ONCE and folded into its system prompt (persona), so it already HOLDS them and never re-reads them every
// turn. Proves: (1) the Dietician's family diet specs are folded into its persona; (2) folding is SCOPE-JAILED —
// a doc outside the agent's foldScope is silently dropped (you can fold only what the agent may read);
// (3) setFoldDocs persists an override the Agent editor can write.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

test('an agent\'s standing docs FOLD into its persona, scope-jailed + override-persisted', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-vault-'));
  fs.mkdirSync(path.join(vault, 'Dietician'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Dietician', 'Diet Preferences.md'), '# Diet Preferences\nFAMILY_FRAMEWORK_MARKER low-FODMAP household\n');
  fs.writeFileSync(path.join(vault, 'Dietician', 'Alexa — Diet.md'), '# Alexa Diet\nALEXA_SPEC_MARKER avoids corn + garlic\n');
  fs.writeFileSync(path.join(vault, 'Dietician', 'Dan — Diet.md'), '# Dan Diet\nDAN_SPEC_MARKER no shellfish\n');
  fs.mkdirSync(path.join(vault, 'Personal'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Personal', 'secret.md'), '# Secret\nSECRET_MARKER private outside the diet folder\n');
  process.env.OBSIDIAN_VAULT = vault;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-out-'));
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json');
  const foldFile = path.join(outDir, 'fold-docs.json');
  process.env.SPECIALISTS_FILE = path.join(outDir, 'specialists.json'); // fold-docs.json sits beside it
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'specialists.json') });
  try {
    // (1) the Dietician's standing diet specs are folded into its persona
    const persona = await fa.foldedPersonaFor('dietician', 'BASE_DIETICIAN_PERSONA');
    assert.match(persona, /BASE_DIETICIAN_PERSONA/, 'the base persona is preserved');
    assert.match(persona, /FAMILY_FRAMEWORK_MARKER/, 'the family framework doc is folded in');
    assert.match(persona, /ALEXA_SPEC_MARKER/, "Alexa's diet spec is folded in");
    assert.match(persona, /DAN_SPEC_MARKER/, "Dan's diet spec is folded in");
    assert.match(persona, /do NOT search for or re-read/i, 'the folded block tells the agent not to re-read');

    // (2) scope-jail: point the Dietician at a doc OUTSIDE its foldScope → it is NOT folded
    fa.setFoldDocs('dietician', { foldScope: 'Dietician', foldDocs: ['Dietician/Alexa — Diet.md', 'Personal/secret.md'] });
    const jailed = await fa.foldedPersonaFor('dietician', 'BASE');
    assert.match(jailed, /ALEXA_SPEC_MARKER/, 'an in-scope doc still folds');
    assert.doesNotMatch(jailed, /SECRET_MARKER/, 'an out-of-scope doc is silently dropped (fold only what you may read)');

    // (3) the override is persisted (the Agent editor writes here)
    assert.ok(fs.existsSync(foldFile), 'fold-docs.json override file is written');
    const saved = JSON.parse(fs.readFileSync(foldFile, 'utf8'));
    assert.equal(saved.dietician.foldScope, 'Dietician', 'the persisted override records the scope');
    assert.ok(saved.dietician.foldDocs.includes('Personal/secret.md'), 'the persisted list is recorded verbatim (scope-jail is at fold time, not config time)');

    // an agent with NO foldDocs gets its persona back unchanged
    const plain = await fa.foldedPersonaFor('researcher', 'RESEARCHER_BASE');
    assert.equal(plain, 'RESEARCHER_BASE', 'an agent with no standing docs is a no-op');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  }
});
