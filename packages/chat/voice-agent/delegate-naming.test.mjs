// delegate-naming.test.mjs — delegated/scoped agents get HUMAN pet names (never an ugly "scoped-<hex>"
// id), and the self-applied-changes CHANGELOG is queryable. Guards the operator-requested behaviour.
//   node --test packages/chat/voice-agent/delegate-naming.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFieldAgent } from './agent-caps.mjs';

const fa = makeFieldAgent({ outDir: '/tmp/_dn_out', baseUrl: 'http://localhost:8778' });
const PET = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "Cobalt Otter"

test('a scoped cap with NO label gets a human pet name, not a bare id', () => {
  const m = fa.mintScopedCap({ powers: ['notes'] });
  assert.ok(m.ok && m.name, 'mint returns a name');
  assert.match(m.name, PET, 'the name is a friendly two-word pet name');
  assert.doesNotMatch(m.name, /^scoped-|^[0-9a-f]{6,}/, 'never the raw scoped-<hex> id');
});

test('a GENERIC label ("chat"/"subchat") is replaced by a pet name; a REAL label is kept', () => {
  assert.match(fa.mintScopedCap({ powers: ['notes'], label: 'subchat' }).name, PET, 'generic → pet name');
  assert.match(fa.mintScopedCap({ powers: ['notes'], label: 'chat' }).name, PET, 'generic → pet name');
  assert.equal(fa.mintScopedCap({ powers: ['notes'], label: 'Trip Planner' }).name, 'Trip Planner', 'real label kept');
});

test('pet names vary across mints (not a constant)', () => {
  const names = new Set(Array.from({ length: 8 }, () => fa.mintScopedCap({ powers: ['notes'] }).name));
  assert.ok(names.size > 1, 'the generator produces varied names');
});

test('the self-applied-changes CHANGELOG is queryable + revert is exposed', () => {
  assert.ok(Array.isArray(fa.changelog.list({ limit: 5 })), 'changelog.list returns an array (empty until an auto-merge)');
  assert.equal(typeof fa.changelog.revert, 'function', 'changelog.revert is callable');
  const { toolbox } = fa.rootNode.toolbox({ chatId: 't' });
  assert.ok(toolbox.listChangelog && toolbox.revertChange, 'the root agent holds listChangelog + revertChange verbs');
});
