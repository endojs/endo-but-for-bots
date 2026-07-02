// render-check-sandbox.test.mjs — proves the render-check CHILD is a KERNEL boundary, not just lexical
// shadowing. The child MUST execute agent-authored source to smoke-test its mount; the standard sandbox
// escapes (`this.process`, `Function.prototype.constructor`, dynamic `import()`) defeat `new Function`
// shadowing and reach the real global — so the child is spawned inside bwrap (`--unshare-all`, read-only
// system+repo). These tests fire those exact escapes and confirm they cannot write outside the jail or
// read a host secret. If bwrap can't run here (nested sandbox), they SKIP (the boundary still holds live).
//
// Run: node --test render-check-sandbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderCheck } from './render-check.mjs';

// a host path OUTSIDE every bwrap bind (the repo is bound ro; /home/dan itself is NOT) — a successful
// escape would create this file on the real host. It must never appear.
const HOST_PROOF = `/home/dan/.render-check-escape-proof-${process.pid}`;
const cleanup = () => { try { fs.unlinkSync(HOST_PROOF); } catch { /* absent = good */ } };
cleanup();

// Detect whether bwrap actually ran (a benign source should return a REAL verdict, not `skipped`).
const probe = await renderCheck(`(ui) => ui.create('div')`, { kind: 'ui' });
const skip = probe.skipped ? `bwrap unavailable here (${probe.skipped}) — kernel boundary still enforced live` : false;

test('escape via Function.prototype.constructor cannot write outside the jail', { skip }, async () => {
  const src = `(ui) => {
    try {
      const g = Function.prototype.constructor('return this')();
      g.process.mainModule.require('fs').writeFileSync(${JSON.stringify(HOST_PROOF)}, 'pwned');
    } catch (e) { /* blocked at some layer — that is the point */ }
    return ui.create('div');
  }`;
  await renderCheck(src, { kind: 'ui' });
  assert.equal(fs.existsSync(HOST_PROOF), false, 'the escape must NOT have written a file on the host');
  cleanup();
});

test('escape via this.process cannot write outside the jail', { skip }, async () => {
  const src = `function (ui) {
    try { this.process.mainModule.require('fs').writeFileSync(${JSON.stringify(HOST_PROOF)}, 'pwned'); }
    catch (e) { /* blocked */ }
    return ui.create('div');
  }`;
  await renderCheck(src, { kind: 'ui' });
  assert.equal(fs.existsSync(HOST_PROOF), false, 'the this.process escape must NOT have written on the host');
  cleanup();
});

test('escape cannot read a host secret (fs is confined to the ro repo bind)', { skip }, async () => {
  // If the escape could read ~/.config, this would render the secret's bytes; instead it throws/ENOENTs.
  const src = `(ui) => {
    const g = Function.prototype.constructor('return this')();
    const s = g.process.mainModule.require('fs').readFileSync('/home/dan/.config/field-agent/email.json', 'utf8');
    return ui.create('div').text(s);
  }`;
  const r = await renderCheck(src, { kind: 'ui' });
  // Either it threw building (secret unreadable) — never ok with the secret rendered.
  assert.equal(r.ok, false, 'reading a host secret must fail the render (it is outside the jail)');
});

test.after(cleanup);
