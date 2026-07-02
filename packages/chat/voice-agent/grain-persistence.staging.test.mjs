// grain-persistence.staging.test.mjs — ARCH-9 end-to-end (isolated server, ephemeral port, mkdtemp stores;
// NEVER the live :8778). Proves the grain path reaches EVERY component kind and survives a source swap:
//   (1) a broken-out uicomp component HOLDS grain data (write via /components/grain, read via /components/history);
//   (2) its grains SURVIVE a REVERT — not orphaned (the flagged git-only gap);
//   (3) an ISLAND holds + retrieves grain data via the (now grain-carrying) /components/history island branch.
// Migration-hook semantics (rename/orphan) are proven deterministically in grain-store.test.mjs; here we prove
// the ROUTES are wired and grains are byte-preserved across the real revert code path.
//
//   node grain-persistence.staging.test.mjs
import assert from 'node:assert/strict';
import { startIsolatedServer } from './test-harness.cjs';

const post = async (base, cap, pathname, body) => {
  const r = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cap, ...body }),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
};

const run = async () => {
  const srv = await startIsolatedServer();
  const { base, cap } = srv;
  assert.ok(cap, 'got an isolated root cap');
  try {
    // ── (1) broken-out uicomp component HOLDS grain data ────────────────────────────────────────────────
    const bo = await post(base, cap, '/components/break-out', {
      source: "(ui) => ui.h('div', null, 'hello')", name: 'GrainTest', cells: [],
    });
    assert.equal(bo.json?.ok, true, `break-out ok: ${JSON.stringify(bo.json)}`);
    const id = bo.json.id;
    assert.match(id, /^uicomp-/, 'got a uicomp id');

    const w = await post(base, cap, '/components/grain', { id, name: 'clicks', value: 5 });
    assert.equal(w.json?.ok, true, `grain write ok: ${JSON.stringify(w.json)}`);

    let hist = await post(base, cap, '/components/history', { id });
    assert.equal(hist.json?.ok, true, 'history ok');
    assert.equal(hist.json.grains?.clicks, 5, 'uicomp HOLDS the grain data (surfaced in history)');
    const versions = hist.json.versions || [];
    assert.ok(versions.length >= 1, 'uicomp has at least a seed version');

    // ── (2) grains SURVIVE a REVERT of a git-only (uicomp) component ─────────────────────────────────────
    const seedVersion = versions[versions.length - 1].version; // oldest = the break-out seed
    const rv = await post(base, cap, '/components/revert', { id, version: seedVersion });
    assert.notEqual(rv.json?.ok, false, `revert ok: ${JSON.stringify(rv.json)}`);

    hist = await post(base, cap, '/components/history', { id });
    assert.equal(hist.json.grains?.clicks, 5, 'grain SURVIVED the revert — not orphaned (git-only grain path ran)');

    // a counter grain (sum-merge) + revert again → both grains still there
    await post(base, cap, '/components/grain', { id, name: 'hits', value: 3, merge: 'sum' });
    await post(base, cap, '/components/grain', { id, name: 'hits', value: 4, merge: 'sum' });
    const rv2 = await post(base, cap, '/components/revert', { id, version: seedVersion });
    assert.notEqual(rv2.json?.ok, false, 'second revert ok');
    hist = await post(base, cap, '/components/history', { id });
    assert.equal(hist.json.grains?.hits, 7, 'accumulated (sum-merge) grain survives revert');
    assert.equal(hist.json.grains?.clicks, 5, 'original grain still intact');

    // ── (3) an ISLAND holds + retrieves grain data via /components/history (island branch now carries grains) ─
    const islandId = 'island-shares-panel';
    const iw = await post(base, cap, '/components/grain', { id: islandId, name: 'expanded', value: true });
    assert.equal(iw.json?.ok, true, `island grain write ok: ${JSON.stringify(iw.json)}`);
    const ih = await post(base, cap, '/components/history', { id: islandId });
    assert.equal(ih.json?.ok, true, 'island history ok');
    assert.ok(Array.isArray(ih.json.versions), 'island returns versions');
    assert.equal(ih.json.grains?.expanded, true, 'ISLAND holds grain data (island history branch now carries grains — the gap)');

    // ── cap-gating sanity: the grain write route is root-gated like the rest of /components/* ──────────────
    const noCap = await post(base, '', '/components/grain', { id, name: 'x', value: 1 });
    assert.equal(noCap.status, 403, 'grain write refuses a missing root cap');

    console.log('PASS grain-persistence.staging: uicomp holds+survives-revert, island holds, cap-gated');
  } finally {
    srv.close();
  }
};

run().then(() => process.exit(0)).catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
