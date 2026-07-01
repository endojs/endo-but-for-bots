// render-check.test.mjs — unit proof of the authoring-loop render smoke (render-check.mjs).
//
// The two failing cases mirror EXACTLY the two bugs from live chat 1cbe89a9 (2026-07-01), where an
// agent shipped a broken slider widget twice and never saw either error:
//   v1: a bare identifier referenced outside the scope it was destructured in
//       → ReferenceError "safeSaleAmount is not defined" at mount.
//   v2: treating ui.local()'s single grain as a per-key cell record (state.valuationCap.get())
//       → TypeError "Cannot read properties of undefined (reading 'get')" at mount.
// Both passed the old syntax-only gate; both must now FAIL the render check with the frame's phrasing.
//
// Run: node --test render-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCheck } from './render-check.mjs';

// ── kind: ui — the showComponent / confined.html pipeline ───────────────────────────────────────────
test('ui: a good component passes', async () => {
  const r = await renderCheck(`(ui) => {
    const state = ui.local({ n: 1 });
    return ui.island('Card', { title: 'ok', body: ui.create('div').text(String(state.get().n))
      .push([ ui.create('input').attr('type', 'range').on('input', e => state.set({ n: 2 })), ui.island('Badge', { label: 'x' }) ]) });
  }`, { kind: 'ui' });
  assert.equal(r.ok, true, r.error);
});

test('ui: chat-1cbe89a9 v1 — bare identifier out of scope → the frame error, caught here', async () => {
  const r = await renderCheck(`(ui) => {
    const state = ui.local({ valuationCap: 5000000, safeSaleAmount: 1000000 });
    const calc = () => { const { valuationCap, safeSaleAmount } = state.get(); return safeSaleAmount / valuationCap; };
    return ui.island('Card', { title: 'Equity', body: ui.create('div').push([
      ui.island('Badge', { label: \`\${(safeSaleAmount / 100).toFixed(2)}%\` }), // BUG: bare identifier — only destructured inside calc()
    ]) });
  }`, { kind: 'ui' });
  assert.equal(r.ok, false);
  assert.match(r.error, /component threw while building/);
  assert.match(r.error, /safeSaleAmount is not defined/);
});

test('ui: chat-1cbe89a9 v2 — ui.local misused as per-key cells → caught', async () => {
  const r = await renderCheck(`(ui) => {
    const state = ui.local({ valuationCap: 5000000 });
    return ui.island('Card', { title: 'Equity', body: ui.create('div').push([
      ui.island('Meta', { parts: [{ label: 'Cap', value: \`\${(state.valuationCap.get() / 1e6).toFixed(1)}M\` }] }), // BUG: ui.local returns ONE grain
    ]) });
  }`, { kind: 'ui' });
  assert.equal(r.ok, false);
  assert.match(r.error, /component threw while building/);
  assert.match(r.error, /reading 'get'/);
});

test('ui: not-a-function source → the frame parse error', async () => {
  const r = await renderCheck(`uiCreate('div')`, { kind: 'ui' });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a function \(ui\) => element/);
});

test('ui: wrong return value → the frame element error', async () => {
  const r = await renderCheck(`(ui) => 42`, { kind: 'ui' });
  assert.equal(r.ok, false);
  assert.match(r.error, /must return ui\.create/);
});

test('ui: an infinite build loop times out instead of hanging the caller', async () => {
  const r = await renderCheck(`(ui) => { while (true) {} }`, { kind: 'ui', timeoutMs: 2500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('ui: node ambient globals are out of lexical reach (shadowed to undefined)', async () => {
  const r = await renderCheck(`(ui) => { require('node:fs'); return ui.create('div'); }`, { kind: 'ui' });
  assert.equal(r.ok, false);
  assert.match(r.error, /component threw while building/); // require is shadowed → TypeError
  const r2 = await renderCheck(`(ui) => { process.exit(2); return ui.create('div'); }`, { kind: 'ui' });
  assert.equal(r2.ok, false); // process shadowed → throws, never exits the checker with a bogus verdict
});

// ── kind: fork — the (endowments, props) => vnode / confineComponent pipeline ───────────────────────
test('fork: a good fork passes (kit vocabulary available as globals)', async () => {
  const r = await renderCheck(`(endowments, props) => endowments.h(Card, { title: 'hi', body: endowments.h('div', null, 'ok') })`, { kind: 'fork' });
  assert.equal(r.ok, true, r.error);
});

test('fork: an undefined variable at render is caught (was a SILENT null render before)', async () => {
  const r = await renderCheck(`(endowments, props) => endowments.h('div', null, String(totallyUndefinedVar))`, { kind: 'fork' });
  assert.equal(r.ok, false);
  assert.match(r.error, /fork threw while rendering/);
  assert.match(r.error, /totallyUndefinedVar is not defined/);
});

test('fork: hooks work for the smoke call', async () => {
  const r = await renderCheck(`(endowments, props) => { const [v] = endowments.useState(3); return endowments.h('div', null, String(v)); }`, { kind: 'fork' });
  assert.equal(r.ok, true, r.error);
});

test('fork: returning undefined (a blank widget) is an error', async () => {
  const r = await renderCheck(`(endowments, props) => { endowments.h('div', null, 'built but not returned'); }`, { kind: 'fork' });
  assert.equal(r.ok, false);
  assert.match(r.error, /undefined/);
});

test('fork: a sample props value flows into the check', async () => {
  const r = await renderCheck(`(endowments, props) => endowments.h('div', null, props.value.name.toUpperCase())`, { kind: 'fork', props: { value: { name: 'x' } } });
  assert.equal(r.ok, true, r.error);
});
