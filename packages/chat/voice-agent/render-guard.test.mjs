// render-guard.test.mjs — the deterministic core of the "[object Object]" render-smell guard.
//   node --test packages/chat/voice-agent/render-guard.test.mjs
//
// Invariants the recurring bug exposed:
//   1. a JS object dropped into a text slot is DETECTED (not silently coerced to "[object Object]");
//   2. safeText() NEVER produces a coercion smell, yet stays readable (renders the data);
//   3. leaked promises / maps / errors are caught too (any "[object Xxx]" tag), not just plain objects;
//   4. the agent-facing feedback names the smell and tells the agent how to fix it.
import '@endo/init';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, coercesToSmell, safeText, inspectForText, smellFeedback } from './render-guard.mjs';

test('scanText finds every [object Xxx] fingerprint', () => {
  assert.deepEqual(scanText('hello [object Object] world'), ['[object Object]']);
  assert.deepEqual(scanText('a=[object Object], b=[object Promise]'), ['[object Object]', '[object Promise]']);
  assert.deepEqual(scanText('all good here'), []);
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText(null), []);
});

test('coercesToSmell flags objects/promises/maps but not primitives', () => {
  assert.equal(coercesToSmell({ a: 1 }), true);
  assert.equal(coercesToSmell(Promise.resolve(1)), true);
  assert.equal(coercesToSmell(new Map([['k', 'v']])), true);
  assert.equal(coercesToSmell(new Date()), false); // Date has its own toString — not a smell
  assert.equal(coercesToSmell('a string'), false);
  assert.equal(coercesToSmell(42), false);
  assert.equal(coercesToSmell(null), false);
  assert.equal(coercesToSmell([1, 2, 3]), false); // arrays join, not "[object Array]"
});

test('safeText never emits a coercion smell but stays readable', () => {
  // the exact bug: an object in a text slot
  const out = safeText({ title: 'Hi', count: 3 });
  assert.ok(!out.includes('[object'), `must not contain a smell, got: ${out}`);
  assert.ok(out.includes('Hi'), 'should surface the data, not hide it');
  // primitives pass straight through
  assert.equal(safeText('plain'), 'plain');
  assert.equal(safeText(7), '7');
  assert.equal(safeText(false), 'false');
  assert.equal(safeText(null), '');
  assert.equal(safeText(undefined), '');
  // functions in a text slot render nothing rather than their source
  assert.equal(safeText(() => 42), '');
  // a leaked promise → a marker, never "[object Promise]"
  assert.equal(safeText(Promise.resolve(1)), '⟨pending…⟩');
  // truncation is honoured and still smell-free
  const big = safeText({ blob: 'x'.repeat(1000) }, { max: 50 });
  assert.ok(big.length <= 50 && !big.includes('[object'));
});

test('safeText output itself passes the scanner (round-trip safety)', () => {
  for (const v of [{ a: { b: { c: 1 } } }, new Map(), [{}, {}], Promise.resolve(), () => {}, Symbol('s')]) {
    assert.deepEqual(scanText(safeText(v)), [], `safeText(${String(v)}) leaked a smell`);
  }
});

test('inspectForText returns safe text + an actionable smell descriptor', () => {
  const clean = inspectForText('all good', { where: 'Card.body' });
  assert.equal(clean.smell, null);
  assert.equal(clean.text, 'all good');

  const dirty = inspectForText({ oops: true }, { where: 'Card.body' });
  assert.ok(!dirty.text.includes('[object'));
  assert.ok(dirty.smell);
  assert.equal(dirty.smell.tag, '[object Object]');
  assert.equal(dirty.smell.where, 'Card.body');
});

test('smellFeedback names the smell + the fix, and is agent-actionable', () => {
  const fb = smellFeedback([{ tag: '[object Object]' }], { where: 'Card.body' });
  assert.ok(fb.includes('[object Object]'));
  assert.ok(fb.includes('Card.body'));
  assert.ok(/JSON\.stringify|field|children/i.test(fb), 'must tell the agent how to fix it');
  // tolerant of bare-string smells + missing where
  const fb2 = smellFeedback(['[object Promise]']);
  assert.ok(fb2.includes('[object Promise]'));
});
