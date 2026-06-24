// skills.test.mjs — the SKILL LIBRARY (skills.mjs). A skill is a drop-in folder
// holding a SKILL.md. Proves: a fresh root lists NOTHING; a SKILL.md dropped in
// then APPEARS and reads back; and an unknown name — including a path-traversal
// attempt like "../secret" or an absolute path — returns null and never escapes
// the skills root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSkillLibrary } from './skills.mjs';

const mkRoot = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const root = path.join(base, 'skills');
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
};

test('empty on a fresh skills root', () => {
  const { base, root } = mkRoot();
  const lib = makeSkillLibrary({ root });
  assert.deepEqual(lib.skillList(), [], 'no skills before any are dropped in');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a non-existent root is also empty (no crash)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const lib = makeSkillLibrary({ root: path.join(base, 'does-not-exist') });
  assert.deepEqual(lib.skillList(), [], 'missing root → []');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a dropped-in SKILL.md appears in the list and reads back', () => {
  const { base, root } = mkRoot();
  const lib = makeSkillLibrary({ root });

  // Drop in a skill folder with a SKILL.md.
  const body = '# Berlin Trip\nPlan a trip to Berlin.\n';
  fs.mkdirSync(path.join(root, 'berlin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'berlin', 'SKILL.md'), body);

  assert.deepEqual(lib.skillList(), ['berlin'], 'the new skill appears');
  assert.equal(lib.skillText('berlin'), body, 'its SKILL.md reads back verbatim');

  // A folder WITHOUT a SKILL.md is not a skill.
  fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'not-a-skill', 'README.md'), 'x');
  assert.deepEqual(lib.skillList(), ['berlin'], 'a folder without SKILL.md is ignored');

  // A second skill → sorted listing.
  fs.mkdirSync(path.join(root, 'apollo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apollo', 'SKILL.md'), '# Apollo\n');
  assert.deepEqual(lib.skillList(), ['apollo', 'berlin'], 'skills are listed sorted');

  fs.rmSync(base, { recursive: true, force: true });
});

test('unknown name returns null; no path traversal escapes the root', () => {
  const { base, root } = mkRoot();
  const lib = makeSkillLibrary({ root });

  // Plant a secret file OUTSIDE the skills root that a traversal would target.
  const secret = path.join(base, 'secret.md');
  fs.writeFileSync(secret, 'TOP SECRET — must never be read via a skill name');

  assert.equal(lib.skillText('nope'), null, 'unknown skill → null');

  // Traversal attempts must all be refused (null), never reading the secret.
  for (const evil of [
    '..',
    '../',
    '../secret',
    '../secret.md',
    '..\\secret.md',
    'a/../../secret',
    './berlin',
    secret,            // absolute path
    '/etc/passwd',
    '',
    'foo/bar',
  ]) {
    assert.equal(lib.skillText(evil), null, `traversal/invalid name refused: ${JSON.stringify(evil)}`);
  }

  // Sanity: a real skill placed inside is still readable (proves the guard
  // isn't just blanket-rejecting everything).
  fs.mkdirSync(path.join(root, 'ok'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok', 'SKILL.md'), 'fine');
  assert.equal(lib.skillText('ok'), 'fine', 'a legitimate name still works');

  fs.rmSync(base, { recursive: true, force: true });
});
