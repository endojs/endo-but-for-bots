#!/usr/bin/env node
// component-backlog.staging.test.cjs — STAGING proof of the per-component/fork BACKLOG (dan's rule:
// creating a component implicitly endows the creator with the right to add to and receive requests on
// its backlog — issue requests, errors thrown, and things).
//
// Against an ISOLATED server instance (throwaway state, no LLM spend), the whole loop:
//   1. create a fork → the creator's backlog EXISTS and is EMPTY (implicit endowment at birth);
//      the edit-chat context (via the contextPreview observability seam) is clean.
//   2. a runtime error carrying the fork's identity (/error/flag + forkId) AUTO-FILES onto its backlog;
//      the identical re-throw MERGES as count (the propagator lattice join), not a duplicate row.
//   3. a share recipient files an issue through the ADD-ONLY facet (/forks/backlog/report, token only)
//      — and canNOT read: no cap → owner verbs 403/refuse; the backlog:<id> cell refuses non-owners.
//   4. the edit-chat context now CONTAINS both items (the agent discusses editing it already informed).
//   5. the OWNER's backlog:<id> propagator cell (one /cells/subscribe stream) pushes the open view LIVE:
//      an ack via the owner facet arrives as a pushed cell update — no refresh, no poll.
//   6. ack clears: both items resolved → open view empty → the edit-chat context is clean again.
//   7. the same shape for a broken-out COMPONENT (uicomp-): break-out endows, share recipient reports
//      add-only, root reads/acks.
// Run: node component-backlog.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pj = async (p, body) => (await post(p, body)).json();

// read SSE frames from a kept-open /cells/subscribe stream (the propagator cell over the wire).
const openCellStream = async (body) => {
  const res = await post('/cells/subscribe', body);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  const waiters = [];
  (async () => {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        try { const m = JSON.parse(line.slice(5).trim()); frames.push(m); while (waiters.length) waiters.shift()(); } catch { /* */ }
      }
    }
  })().catch(() => {});
  const next = async (pred, ms = 6000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = frames.find(pred); if (hit) return hit;
      if (Date.now() - t0 > ms) return null;
      await new Promise(r => { waiters.push(r); setTimeout(r, 250); });
    }
  };
  return { frames, next, close: () => { try { reader.cancel(); } catch { /* */ } } };
};

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), BACKLOG_STORE: path.join(tmp, 'backlog.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway VOICE_STATE_DIR/BACKLOG_STORE)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. implicit endowment at creation: fork born with an EMPTY backlog; edit-chat context clean ──
  const src = "(endowments, props) => endowments.h('div', null, 'backlog proof v1')";
  const created = await pj('/forks/create', { cap, source: src, name: 'BacklogFork' });
  ok(created.ok && created.id, `fork created (${created.id})`);
  const fid = created.id;
  const empty = await pj('/forks/backlog', { cap, id: fid });
  ok(empty.ok && Array.isArray(empty.items) && empty.items.length === 0, 'the creator sees an EMPTY backlog — the owner facet existed from birth (implicit endowment)');
  const pv0 = await pj('/forks/edit-chat', { cap, id: fid, contextPreview: true });
  ok(pv0.ok && pv0.preview && !/OPEN BACKLOG/.test(pv0.persona || ''), 'edit-chat context (contextPreview) starts CLEAN — no backlog note');

  // ── 2. a runtime error carrying the fork's identity auto-files; a re-throw merges as count ──
  const flagged = await pj('/error/flag', { cap, kind: 'component-render', sessionId: 'bl-sid', name: 'BacklogFork', forkId: fid, error: 'fork threw while rendering: paint is not defined', source: '(e,p)=>…' });
  ok(flagged.ok && flagged.backlogged === true, 'a runtime error with forkId AUTO-FILES onto the fork’s backlog (backlogged:true)');
  await pj('/error/flag', { cap, kind: 'component-render', sessionId: 'bl-sid2', name: 'BacklogFork', forkId: fid, error: 'fork threw while rendering: paint is not defined' });
  const afterErr = await pj('/forks/backlog', { cap, id: fid });
  ok(afterErr.items.length === 1 && afterErr.items[0].kind === 'error' && afterErr.items[0].count === 2 && afterErr.items[0].from === 'runtime',
    `the re-thrown error MERGED (1 row, count 2, from runtime) — the lattice join, not a duplicate — got ${JSON.stringify(afterErr.items.map(i => ({ k: i.kind, c: i.count, f: i.from })))}`);
  const bogus = await pj('/error/flag', { cap, kind: 'component-render', sessionId: 'bl-sid3', forkId: 'fork-doesnotexist', error: 'x' });
  ok(bogus.backlogged === false, 'an unknown fork identity does NOT grow a phantom backlog (identity validated against the store)');

  // ── 3. attenuated ADD-ONLY facet: a share recipient files an issue, and cannot read ──
  const share = await pj('/forks/share', { cap, id: fid, charge: { scheme: 'free' } });
  ok(share.ok && share.token, 'owner minted a share token');
  const filed = await pj('/forks/backlog/report', { token: share.token, title: 'the button does nothing on mobile' });
  ok(filed.ok === true && !('items' in filed), 'the recipient FILED an issue via token — and the response echoes NO backlog state (add-only)');
  const noCap = await post('/forks/backlog', { cap: share.token, id: fid });
  ok(noCap.status === 403 || (await noCap.json()).ok === false, 'the token is NOT a cap: the owner read verb refuses it');
  const list2 = await pj('/forks/backlog', { cap, id: fid });
  const issue = list2.items.find(i => i.kind === 'issue');
  ok(!!issue && /share-[0-9a-f]{8}/.test(issue.from), `the owner sees the issue tagged by an OPAQUE share prefix (${issue && issue.from}) — never the token`);
  // the add-only facet gains no subscription: a recipient (no cap) subscribing to the backlog cell is refused
  const denied = await openCellStream({ cap: share.token, cells: [`backlog:${fid}`] });
  const deniedFrame = await denied.next(m => m && (m.error || m.value), 4000);
  ok(!deniedFrame || !!deniedFrame.error, `the backlog:<id> cell REFUSES a non-owner (got ${JSON.stringify(deniedFrame).slice(0, 80)}) — the cell is the owner's read surface only`);
  denied.close();

  // ── 4. the edit-chat context now carries BOTH items ──
  const pv1 = await pj('/forks/edit-chat', { cap, id: fid, contextPreview: true });
  ok(pv1.ok && /OPEN BACKLOG/.test(pv1.persona) && /paint is not defined/.test(pv1.persona) && /button does nothing on mobile/.test(pv1.persona),
    'the edit-chat agent context CONTAINS both backlog items (error + recipient issue) — discussing the edit is auto-informed');
  ok(/resolveBacklogItem/.test(pv1.persona) && pv1.backlogOpen === 2, `…and offers resolveBacklogItem (open=${pv1.backlogOpen})`);

  // ── 5. the OWNER's backlog cell pushes LIVE: subscribe, then ack, and watch the open view shrink ──
  const cellStream = await openCellStream({ cap, cells: [`backlog:${fid}`] });
  const first = await cellStream.next(m => m && m.value && m.value.counts);
  ok(!!first && first.value.counts.open === 2, `the owner's backlog:<id> cell pushes the CURRENT open view on subscribe (open=${first && first.value.counts.open})`);
  const ack1 = await pj('/forks/backlog/ack', { cap, id: fid, itemId: issue.id, status: 'done' });
  ok(ack1.ok && ack1.status === 'done', 'owner acked the recipient issue via the owner facet');
  const pushed = await cellStream.next(m => m && m.value && m.value.counts && m.value.counts.open === 1);
  ok(!!pushed, 'the ack arrived as a PUSHED cell update on the open stream (open=1) — propagator, no refresh/poll');
  cellStream.close();

  // ── 6. ack clears: resolve the error too → empty open view → clean context again ──
  const errItem = (await pj('/forks/backlog', { cap, id: fid })).items.find(i => i.kind === 'error');
  await pj('/forks/backlog/ack', { cap, id: fid, itemId: errItem.id, status: 'done' });
  const cleared = await pj('/forks/backlog', { cap, id: fid, status: 'open' });
  ok(cleared.items.length === 0 && cleared.counts.open === 0, 'both items resolved — the open view is empty (history kept: total intact)');
  const pv2 = await pj('/forks/edit-chat', { cap, id: fid, contextPreview: true });
  ok(pv2.ok && !/OPEN BACKLOG/.test(pv2.persona), 'ack CLEARS the edit-chat injection — the context is clean again');

  // ── 7. the same shape for a broken-out COMPONENT (uicomp-) ──
  const uiSrc = "(ui) => ui.create('div').text('component backlog proof')";
  const broke = await pj('/components/break-out', { cap, source: uiSrc, name: 'BacklogComp', cells: [] });
  ok(broke.ok && /^uicomp-/.test(broke.id || ''), `component broken out (${broke.id}) — backlog endowed at birth`);
  const cEmpty = await pj('/components/backlog', { cap, id: broke.id });
  ok(cEmpty.ok && cEmpty.items.length === 0, 'the component backlog exists and is empty');
  const cShare = await pj('/components/share', { cap, id: broke.id, charge: { scheme: 'free' } });
  ok(cShare.ok && cShare.url && /#k=/.test(cShare.url), 'component share minted');
  const cTok = cShare.url.split('#k=')[1];
  const cFiled = await pj('/components/backlog/report', { shareToken: cTok, title: 'the title overflows on small screens' });
  ok(cFiled.ok === true, 'a component-share recipient files an issue via the token (add-only, outside the root gate)');
  const cAnon = await post('/components/backlog', { shareToken: cTok, id: broke.id });
  ok(cAnon.status === 403, 'the token cannot READ the component backlog (the root-gated block refuses it)');
  const cList = await pj('/components/backlog', { cap, id: broke.id });
  ok(cList.items.length === 1 && cList.items[0].kind === 'issue' && /^share-/.test(cList.items[0].from), 'the owner (root) sees the filed issue with the opaque share tag');
  const cErr = await pj('/error/flag', { cap, kind: 'component-render', sessionId: 'bl-c', componentId: broke.id, error: 'component threw while building: fmt is not defined' });
  ok(cErr.backlogged === true, 'a runtime error with componentId auto-files onto the component backlog');
  const cPv = await pj('/components/edit-chat', { cap, id: broke.id, contextPreview: true });
  ok(cPv.ok && /OPEN BACKLOG/.test(cPv.persona) && /title overflows/.test(cPv.persona) && /fmt is not defined/.test(cPv.persona),
    'the component edit-chat context carries both its backlog items');
  const cAck = await pj('/components/backlog/ack', { cap, id: broke.id, itemId: cList.items[0].id, status: 'ack' });
  ok(cAck.ok && cAck.status === 'ack', 'root acks the component issue');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(1); });
