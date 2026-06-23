// delegate-naming.test.mjs — delegated/scoped agents get DESCRIPTIVE names (never an ugly "scoped-<hex>" id):
// a meaningful label if given, else a powers-derived description, else a friendly pet name. The self-applied-
// changes CHANGELOG is queryable. Guards the operator-requested behaviour.
//   node --test packages/chat/voice-agent/delegate-naming.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFieldAgent } from './agent-caps.mjs';

const fa = makeFieldAgent({ outDir: '/tmp/_dn_out', baseUrl: 'http://localhost:8778' });
const PET = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "Cobalt Otter"

test('a scoped cap with NO label gets a DESCRIPTIVE powers-derived name, not a bare id', () => {
  const m = fa.mintScopedCap({ powers: ['notes', 'web'] });
  assert.ok(m.ok && m.name, 'mint returns a name');
  assert.match(m.name, /notes/, 'the name describes its powers');
  assert.match(m.name, /agent$/, 'powers-derived names read like "notes + web agent"');
  assert.doesNotMatch(m.name, /^scoped-|^[0-9a-f]{6,}/, 'never the raw scoped-<hex> id');
});

test('a GENERIC label is replaced by a descriptive name; a REAL label is kept', () => {
  assert.match(fa.mintScopedCap({ powers: ['notes'], label: 'subchat' }).name, /notes/, 'generic → powers-derived');
  assert.match(fa.mintScopedCap({ powers: ['notes'], label: 'chat' }).name, /notes/, 'generic → powers-derived');
  assert.equal(fa.mintScopedCap({ powers: ['notes'], label: 'Trip Planner' }).name, 'Trip Planner', 'real label kept');
});

test('a no-label, NO-powers scoped cap falls back to a varied pet name (not a bare id)', () => {
  const names = Array.from({ length: 8 }, () => fa.mintScopedCap({ powers: [] }).name);
  names.forEach(n => assert.match(n, PET, 'no context → a friendly two-word pet name'));
  assert.ok(new Set(names).size > 1, 'pet-name fallback varies across mints');
});

test('the self-applied-changes CHANGELOG is queryable + revert is exposed', () => {
  assert.ok(Array.isArray(fa.changelog.list({ limit: 5 })), 'changelog.list returns an array (empty until an auto-merge)');
  assert.equal(typeof fa.changelog.revert, 'function', 'changelog.revert is callable');
  const { toolbox } = fa.rootNode.toolbox({ chatId: 't' });
  assert.ok(toolbox.listChangelog && toolbox.revertChange, 'the root agent holds listChangelog + revertChange verbs');
});
