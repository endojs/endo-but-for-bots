// bluesky-ns-wallet.test.mjs — the per-Bluesky-namespace conserved wallet: seed-from-root conservation
// (never minted, clamped when root is short), idempotent ensure, child adoption (sub-chats spend the
// SAME wallet — no thin-air default purses), legacy `${cap}:_namespace` purse migration, cap-hygiene.
// Mirrors invite-allowance.test.mjs: real purses, the exact server wiring shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeBskyNsWallets } from './bluesky-ns-wallet.mjs';
import { makePurse } from './purse.mjs'; // safe: bluesky-ns-wallet.mjs installs the plain-node harden fallback

const SEED = 5_000_000; // the server default: $5
const mk = ({ rootBalance = 100_000_000, seedUusd = SEED } = {}) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bnw-')), 'bluesky-ns-wallets.json');
  const purses = new Map(); // the server's purse ledger, keyed like purseAt
  const purseAt = (k, seed = 0) => { if (!purses.has(k)) purses.set(k, makePurse(seed)); return purses.get(k); };
  const root = purseAt('wallet:root', rootBalance);
  const logs = [];
  const bnw = makeBskyNsWallets({ file, purseAt, rootWallet: () => root, seedUusd,
    legacyKeyFor: nsCap => `${nsCap}:_namespace`, log: m => logs.push(m) });
  return { bnw, purseAt, root, file, logs };
};
const total = (...ps) => ps.reduce((s, p) => s + p.balance(), 0);

test('ensure SEEDS the namespace wallet from wallet:root — a conserved transfer, idempotent', () => {
  const { bnw, purseAt, root } = mk({ rootBalance: 20_000_000 });
  const wid = bnw.ensure('cap-ns-alice');
  const w = purseAt(bnw.purseKeyFor(wid), 0);
  assert.equal(w.balance(), SEED, 'namespace wallet credited the seed');
  assert.equal(root.balance(), 20_000_000 - SEED, 'root debited exactly the seed');
  assert.equal(total(root, w), 20_000_000, 'total conserved — nothing minted');
  assert.equal(bnw.ensure('cap-ns-alice'), wid, 'second ensure returns the same wallet');
  assert.equal(w.balance(), SEED, '…and does NOT re-seed');
  assert.equal(root.balance(), 20_000_000 - SEED, '…and does NOT re-debit root');
});

test('root wallet short → seed is CLAMPED to what root has (never minted, never negative)', () => {
  const { bnw, purseAt, root, logs } = mk({ rootBalance: 1_200_000 }); // root holds less than the $5 seed
  const wid = bnw.ensure('cap-ns-poor');
  const w = purseAt(bnw.purseKeyFor(wid), 0);
  assert.equal(w.balance(), 1_200_000, 'wallet got only what root actually had');
  assert.equal(root.balance(), 0, 'root drained, not overdrawn');
  assert.ok(logs.some(m => /short/.test(m)), 'the shortfall is logged for the operator');
  // an empty root wallet → zero seed, still no minting
  const wid2 = bnw.ensure('cap-ns-broke');
  assert.equal(purseAt(bnw.purseKeyFor(wid2), 0).balance(), 0, 'no root credit → zero-seeded wallet');
});

test('adoption: a sub-chat cap draws from the SAME namespace wallet (transitively) — no thin-air purse', () => {
  const { bnw, purseAt } = mk();
  const wid = bnw.ensure('cap-ns-bob');
  assert.equal(bnw.adopt('cap-ns-bob', 'cap-sub-1'), wid);
  assert.equal(bnw.walletIdFor('cap-sub-1'), wid, 'child routes to the namespace wallet');
  assert.equal(bnw.adopt('cap-sub-1', 'cap-sub-sub'), wid, 'grandchild adopts through the child');
  const w = purseAt(bnw.purseKeyFor(bnw.walletIdFor('cap-sub-sub')), 0);
  assert.equal(w, purseAt(bnw.purseKeyFor(wid), 0), 'literally the same purse object');
  w.debit(1_000_000);
  assert.equal(purseAt(bnw.purseKeyFor(bnw.walletIdFor('cap-sub-1')), 0).balance(), SEED - 1_000_000, 'a child spend debits the shared wallet');
  assert.equal(bnw.adopt('cap-not-a-namespace', 'cap-x'), null, 'no wallet on the parent → nothing recorded');
  assert.equal(bnw.walletIdFor('cap-x'), null);
});

test('MIGRATION: a pre-registry namespace\'s legacy shared-purse balance moves into the wallet (kept, not stranded)', () => {
  const { bnw, purseAt, root } = mk({ rootBalance: 20_000_000 });
  // simulate the old world: an eligible claim credited the legacy `${cap}:_namespace` purse
  const legacy = purseAt('cap-ns-veteran:_namespace', 0);
  legacy.credit(3_000_000);
  const before = total(root, legacy);
  const wid = bnw.ensure('cap-ns-veteran'); // first use under the new scheme
  const w = purseAt(bnw.purseKeyFor(wid), 0);
  assert.equal(w.balance(), SEED + 3_000_000, 'wallet = seed + every µUSD they already had');
  assert.equal(legacy.balance(), 0, 'legacy purse drained into the wallet');
  assert.equal(total(root, legacy, w), before, 'migration conserves the total');
});

test('durable + cap-hygiene: registry survives a restart; raw caps never touch disk', () => {
  const { bnw, purseAt, root, file } = mk();
  const secret = 'cap-ns-supersecret-swissnum-9876';
  const wid = bnw.ensure(secret);
  bnw.adopt(secret, 'cap-child-swiss-4321');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), 'raw namespace cap not on disk');
  assert.ok(!raw.includes('cap-child-swiss-4321'), 'raw child cap not on disk');
  const bnw2 = makeBskyNsWallets({ file, purseAt, rootWallet: () => root, seedUusd: SEED }); // fresh instance = restart
  assert.equal(bnw2.walletIdFor(secret), wid, 'namespace routing survives');
  assert.equal(bnw2.walletIdFor('cap-child-swiss-4321'), wid, 'adoption survives');
  assert.equal(bnw2.ensure(secret), wid, 'ensure after restart does not re-seed');
  assert.equal(bnw2.info(wid).granted, SEED, 'registry remembers the seed grant');
});
