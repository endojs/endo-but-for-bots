// grain-store.test.mjs — ARCH-9: grain-data persistence across a source swap + the schema-MIGRATION hook.
// Grains are USER DATA; the red-line is PRESERVE, never silently drop. This proves:
//   • byte-preservation across a no-op / rename-free swap,
//   • the declarative migration hook (rename carries the value; drop is explicit),
//   • the safe default (a key the new source no longer declares is an ORPHAN → PRESERVED + reported),
//   • the programmatic migrate(oldGrains) evolver,
//   • the same hook reached through custom-tools (setSource, migrateGrains, setGrain),
//   • the island grain wiring (a plain island's applySource/revert runs the hook), all off-tree.
//
//   node --test packages/chat/voice-agent/grain-store.test.mjs
import '@endo/init'; // lockdown + harden FIRST (grain-store.mjs harden()s at module scope)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeGrainStore } from './grain-store.mjs';

const tmp = pfx => fs.mkdtempSync(path.join(os.tmpdir(), pfx));
const store = () => makeGrainStore({ dir: tmp('grains-') });

test('grains are byte-preserved across a swap that declares no migration + no schema', () => {
  const gs = store();
  const c = gs.grainsFor('cmp-1').cell('count', { merge: 'sum' });
  c.addContent(3); c.addContent(4);
  assert.equal(gs.dump('cmp-1').count, 7, 'accumulated');
  const r = gs.migrate('cmp-1', { source: 'some source with no @grain directives and no cell() refs' });
  assert.equal(r.changed, false, 'no schema declared → nothing evolved');
  assert.deepEqual(r.orphans, [], 'no schema declared → no orphan noise');
  assert.equal(gs.dump('cmp-1').count, 7, 'data untouched');
});

test('declarative RENAME carries the old value to the new field (no orphan)', () => {
  const gs = store();
  gs.grainsFor('cmp-2').cell('score').set(42);
  const newSource = [
    '// @grain-migrate rename score points',
    "const c = powers.grains.cell('points');", // new source declares `points`
  ].join('\n');
  const r = gs.migrate('cmp-2', { source: newSource });
  assert.deepEqual(r.renamed, [['score', 'points']], 'reported the rename');
  assert.deepEqual(r.orphans, [], 'renamed value is now in the declared schema — not orphaned');
  const data = gs.dump('cmp-2');
  assert.equal(data.points, 42, 'value carried to the new field');
  assert.equal('score' in data, false, 'old field gone');
});

test('rename never clobbers an existing target value', () => {
  const gs = store();
  const g = gs.grainsFor('cmp-2b');
  g.cell('a').set('OLD'); g.cell('b').set('KEEP');
  const r = gs.migrate('cmp-2b', { source: "// @grain-migrate rename a b\npowers.grains.cell('b')" });
  assert.deepEqual(r.renamed, [['a', 'b']]);
  assert.equal(gs.dump('cmp-2b').b, 'KEEP', 'existing target is NOT overwritten');
  assert.equal('a' in gs.dump('cmp-2b'), false, 'source key still consumed');
});

test('SAFE DEFAULT: a field the new source no longer declares is PRESERVED + reported as an orphan', () => {
  const gs = store();
  const g = gs.grainsFor('cmp-3');
  g.cell('legacyField').set({ big: 'user data' });
  g.cell('kept').set(1);
  // new source declares only `kept` — legacyField is undeclared. It MUST survive.
  const r = gs.migrate('cmp-3', { source: "powers.grains.cell('kept', { merge: 'sum' })" });
  assert.deepEqual(r.orphans, ['legacyField'], 'orphan reported');
  assert.deepEqual(r.dropped, [], 'nothing dropped');
  assert.deepEqual(gs.dump('cmp-3').legacyField, { big: 'user data' }, 'ORPHAN PRESERVED — never silently dropped');
  assert.equal(gs.dump('cmp-3').kept, 1, 'declared field intact');
});

test('explicit DROP is the only non-rename removal — and it is reported', () => {
  const gs = store();
  gs.grainsFor('cmp-4').cell('stale').set('x');
  const r = gs.migrate('cmp-4', { source: "// @grain-migrate drop stale\n// (nothing else)" });
  assert.deepEqual(r.dropped, ['stale'], 'explicit drop reported');
  assert.equal('stale' in gs.dump('cmp-4'), false, 'dropped only because it was explicit');
});

test('programmatic migrate(oldGrains) evolver runs after directives; a throw is non-fatal', () => {
  const gs = store();
  gs.grainsFor('cmp-5').cell('celsius').set(100);
  const r = gs.migrate('cmp-5', {
    source: "powers.grains.cell('fahrenheit')",
    migrate: old => ({ fahrenheit: old.celsius * 9 / 5 + 32 }),
  });
  assert.equal(gs.dump('cmp-5').fahrenheit, 212, 'evolver transformed the data');
  assert.equal('celsius' in gs.dump('cmp-5'), false, 'evolver replaced the shape');
  // a throwing evolver must not wedge the swap or corrupt data
  gs.grainsFor('cmp-6').cell('v').set('safe');
  const r2 = gs.migrate('cmp-6', { source: '', migrate: () => { throw new Error('boom'); } });
  assert.equal(r2.ok, true, 'migrate() throw is caught');
  assert.equal(gs.dump('cmp-6').v, 'safe', 'data intact after a throwing evolver');
});

// ── the same hook reached through custom-tools (tool/uicomp/island uniform id-keyed store) ──────────────
test('custom-tools: setGrain + migrateGrains work for a NON-tool (island/uicomp) id', async () => {
  const CT = tmp('ct-');
  process.env.CUSTOM_TOOLS_STORE = path.join(CT, 'custom-tools.json');
  process.env.CUSTOM_TOOLS_STATE = path.join(CT, 'tool-state');
  process.env.COMPONENT_GRAINS = path.join(CT, 'grains');
  process.env.FIELD_CONFIG_DIR = path.join(CT, 'config');
  const { makeCustomTools } = await import('./custom-tools.mjs');
  const ct = makeCustomTools();
  // an ISLAND id — no tool record exists, yet it can hold + retrieve grain data
  ct.setGrain('island-shares-panel', 'expanded', true);
  assert.equal(ct.grainData('island-shares-panel').expanded, true, 'island holds grain data (no tool record)');
  // a source swap that renames the field carries the value
  const m = ct.migrateGrains('island-shares-panel', { source: "// @grain-migrate rename expanded open\npowers.grains.cell('open')" });
  assert.deepEqual(m.renamed, [['expanded', 'open']]);
  assert.equal(ct.grainData('island-shares-panel').open, true, 'island grain evolved across the swap');
});

test('custom-tools: setSource runs the migration hook for a live tool (data survives + evolves)', async () => {
  const CT = tmp('ct2-');
  process.env.CUSTOM_TOOLS_STORE = path.join(CT, 'custom-tools.json');
  process.env.CUSTOM_TOOLS_STATE = path.join(CT, 'tool-state');
  process.env.COMPONENT_GRAINS = path.join(CT, 'grains');
  process.env.FIELD_CONFIG_DIR = path.join(CT, 'config');
  const { makeCustomTools } = await import('./custom-tools.mjs?tool2'); // fresh module (env re-read)
  const ct = makeCustomTools();
  const p = ct.propose({ name: 'Counter', description: 'c', code: "const c = powers.grains.cell('n', { merge: 'sum' }); return { async bump(){ return c.addContent(1); }, async read(){ return c.read(); } };", proposedBy: 'me', owner: 'root' });
  ct.admit(p.id);
  await ct.call(p.id, { method: 'bump', owner: 'root' });
  await ct.call(p.id, { method: 'bump', owner: 'root' });
  assert.equal(ct.grainData(p.id).n, 2, 'tool accumulated grain data');
  // swap the source, renaming the grain field n → total via a directive
  const swap = ct.setSource(p.id, { 'tool.js': "// @grain-migrate rename n total\nconst c = powers.grains.cell('total', { merge: 'sum' }); return { async read(){ return c.read(); } };" });
  assert.ok(swap.grainMigration && swap.grainMigration.renamed.length === 1, 'setSource ran the migration');
  assert.equal(ct.grainData(p.id).total, 2, 'grain data carried across the source swap');
  const rv = await ct.call(p.id, { method: 'read', owner: 'root' });
  assert.equal(rv.value, 2, 'the reinstantiated tool reads the migrated value under the new name');
});

// ── island wiring: a plain island's applySource/revert runs the hook, OFF the real client tree ──────────
test('island-source: applySource + revert run the grain migration hook (off-tree, plain island)', async () => {
  const { makeIslandSource } = await import('./island-source.mjs');
  // Stand up a fake source tree so we NEVER touch the live public/pendant.js. island-trace is `plain`
  // (no vite rebuild) and maps to public/pendant.js.
  const here = tmp('island-here-');
  fs.mkdirSync(path.join(here, 'public'), { recursive: true });
  fs.writeFileSync(path.join(here, 'public', 'pendant.js'), "// @grain v1\nexport const x = 1;\n");
  // A minimal in-memory componentGit stub (avoids @endo/git-under-SES quirks in-process; island-source
  // only needs exists/commit/history/readAt). Each commit snapshots the {file:content} map.
  const commits = []; // newest last
  const componentGit = {
    exists: () => commits.length > 0,
    commit: async (_id, files, message) => { const version = `v${commits.length + 1}`; commits.push({ version, files: { ...files }, summary: message }); return { version }; },
    history: async () => commits.map(c => ({ version: c.version, summary: c.summary })).reverse(),
    readAt: async (_id, ref) => { const c = ref === 'HEAD' ? commits[commits.length - 1] : commits.find(x => x.version === ref); return c ? { files: { ...c.files }, version: c.version } : null; },
  };
  const calls = [];
  const migrateGrains = (id, opts) => { calls.push({ id, source: opts.source }); return { ok: true, renamed: [], dropped: [], orphans: [], changed: false }; };
  const isl = makeIslandSource({ here, componentGit, migrateGrains });
  const ID = 'island-trace';
  await isl.history(ID); // seed the git lineage from the fake file
  const e = await isl.applySource(ID, "// @grain-migrate rename old new\nexport const x = 2;\n", 'edit x');
  assert.ok(e.ok, `island edit applied: ${e.error || ''}`);
  assert.ok(calls.some(c => c.id === ID && /@grain-migrate rename old new/.test(c.source)), 'applySource called migrateGrains with the new source');
  // and revert also routes through applySource → the hook
  const hist = await isl.history(ID);
  const seed = hist[hist.length - 1].version;
  calls.length = 0;
  const rv = await isl.revert(ID, seed);
  assert.ok(rv.ok, `island revert applied: ${rv.error || ''}`);
  assert.ok(calls.some(c => c.id === ID), 'revert ran the migration hook too');
  // sanity: we only ever wrote to the fake tree
  assert.equal(fs.readFileSync(path.join(here, 'public', 'pendant.js'), 'utf8').includes('export const x'), true, 'stayed on the fake tree');
});
