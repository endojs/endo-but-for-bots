// inbox-cells-tenant-feed.test.mjs — INC-2 residual: a per-TENANT feed write pushes the TENANT's bell cell.
//
// The ARCH-2 fs.watch used to match only the exact `feed.json` basename, so a write to a tenant's
// `feed-<ownerKey>.json` (INC-2) bumped nothing — the tenant's bell refreshed on the next /feed/load poll
// instead of instantly. This drives the REAL fs.watch: a write to a tenant file bumps that tenant's cell (and
// NOT root's), and a write to feed.json bumps root's (and not the tenant's).
//
//   node --test packages/chat/voice-agent/inbox-cells-tenant-feed.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeInboxCells } from './inbox-cells.mjs';

// resolve when (fam,key)'s rev exceeds `from`, else reject after `ms` — so a missed push fails loud, not hangs.
const waitBump = (ic, fam, key, from, ms = 2000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => { unsub(); reject(new Error(`no ${fam}:${key} bump within ${ms}ms`)); }, ms);
  const unsub = ic.cellFor(fam, key).subscribe(v => { if (v.rev > from) { clearTimeout(to); unsub(); resolve(v.rev); } });
});

test('a tenant feed write bumps THAT tenant cell (not root); a root write bumps root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-tenant-'));
  const feedFile = path.join(dir, 'feed.json');
  const asksFile = path.join(dir, 'asks.json');
  const devFile = path.join(dir, 'dev.json');
  const ic = makeInboxCells({ feedFile, asksFile, devFile, debounceMs: 10 });
  try {
    const owner = 'u:abc123def'; // traceOwnerKeyOf-shaped; feedFileFor sanitizes ':' → '_'
    const tenantFile = path.join(dir, 'feed-u_abc123def.json');

    const rootBefore = ic.snapshot('feed', 'root').rev;
    const tenantBefore = ic.snapshot('feed', owner).rev;

    // ── write the TENANT file → the tenant cell must bump, root must NOT ──
    const tenantBumped = waitBump(ic, 'feed', owner, tenantBefore);
    fs.writeFileSync(tenantFile, JSON.stringify({ entries: [{ id: 'x' }] }));
    const tRev = await tenantBumped;
    assert.ok(tRev > tenantBefore, 'the tenant feed cell bumped on its own file write');
    assert.equal(ic.snapshot('feed', 'root').rev, rootBefore, 'root did NOT bump on a tenant write');

    // ── write feed.json → root must bump, the tenant must NOT bump further ──
    const rootNow = ic.snapshot('feed', 'root').rev;
    const tenantNow = ic.snapshot('feed', owner).rev;
    const rootBumped = waitBump(ic, 'feed', 'root', rootNow);
    fs.writeFileSync(feedFile, JSON.stringify({ entries: [{ id: 'y' }] }));
    const rRev = await rootBumped;
    assert.ok(rRev > rootNow, 'root feed cell bumped on feed.json write');
    // give any errant tenant bump a moment; it must not have fired
    await new Promise(r => setTimeout(r, 60));
    assert.equal(ic.snapshot('feed', owner).rev, tenantNow, 'the tenant did NOT bump on a root write');
  } finally {
    ic.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
