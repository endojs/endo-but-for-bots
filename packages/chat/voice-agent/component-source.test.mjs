// component-source.test.mjs — regression proof that the confined-component source VALIDATOR
// (component-source.mjs) no longer EXECUTES agent-authored source in the live server process.
//
// The hole (fixed): validateComponentSource used `new Function(`return (${src});`)()` — the trailing
// `()` INVOKED the compiled wrapper, evaluating the outer expression in-process with ambient Node
// authority, at validation time, BEFORE any isolated render check. A top-level IIFE or comma-operator
// payload therefore ran arbitrary code (reachable via the showComponent tool → indirect prompt injection).
// The fix makes validation PARSE-ONLY: it compiles but NEVER invokes, so no source code executes here.
//
// Run: node --test component-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateComponentSource } from './component-source.mjs';

// A globalThis sentinel a validation-time execution would set. Must stay unset.
delete globalThis.__RCE_SENTINEL__;

test('a comma-operator side-effect payload does NOT execute during validation', () => {
  const src = `(globalThis.__RCE_SENTINEL__ = 'pwned', (ui) => ui.create('div'))`;
  validateComponentSource(src);
  assert.equal(globalThis.__RCE_SENTINEL__, undefined, 'the side effect must NOT have fired at validation');
});

test('a top-level IIFE side-effect payload does NOT execute during validation', () => {
  const sentinel = path.join(os.tmpdir(), `rce-sentinel-${process.pid}-${Date.now()}.txt`);
  try { fs.unlinkSync(sentinel); } catch { /* not there */ }
  // If this evaluated, the IIFE would write the sentinel file, then return a valid component.
  const src = `((() => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); return 0; })(), (ui) => ui.create('div'))`;
  validateComponentSource(src);
  assert.equal(fs.existsSync(sentinel), false, 'the IIFE file-write must NOT have fired at validation');
  try { fs.unlinkSync(sentinel); } catch { /* clean */ }
});

test('a bare side-effect assignment does NOT execute during validation', () => {
  delete globalThis.__RCE_SENTINEL2__;
  validateComponentSource(`globalThis.__RCE_SENTINEL2__ = true`);
  assert.equal(globalThis.__RCE_SENTINEL2__, undefined, 'no assignment side effect at validation');
});

test('invalid syntax is still rejected (parse gate intact)', () => {
  const r = validateComponentSource(`(ui) => { return ui.create('div')`); // missing brace
  assert.equal(r.ok, false);
  assert.match(r.error, /failed to parse/);
});

test('a valid arrow (incl. destructured params) still validates ok', () => {
  assert.equal(validateComponentSource(`(ui) => ui.create('div')`).ok, true);
  assert.equal(validateComponentSource(`({ create, island }) => create('div')`).ok, true);
  assert.equal(validateComponentSource(`(ui) => { const s = ui.local({ n: 1 }); return ui.create('div').text(String(s.get().n)); }`).ok, true);
});

test('empty / oversize sources are rejected', () => {
  assert.equal(validateComponentSource('').ok, false);
  assert.equal(validateComponentSource('   ').ok, false);
  assert.equal(validateComponentSource(`(ui) => ui.create('div')`, { maxLen: 5 }).ok, false);
});
