// invite-allowance.test.mjs — the invite-carries-credit wallet registry: cap→wallet routing, child
// adoption (sub-caps spend the SAME wallet), cap-hygiene (only hashes on disk), and the end-to-end
// conservation of the server wiring shape (real purses: inviter debited ⇄ member wallet credited).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeInviteAllowances } from './invite-allowance.mjs';
import { makePurse } from './purse.mjs'; // safe: invite-allowance.mjs installs the plain-node harden fallback

const mk = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-')), 'invite-allowances.json');
  return { ia: makeInviteAllowances({ file }), file };
};

test('a funded cap routes to its own wallet; an unfunded cap routes nowhere', () => {
  const { ia } = mk();
  const wid = ia.fund('cap-alice-secret', 300000, 'Alex');
  assert.equal(ia.walletIdFor('cap-alice-secret'), wid);
  assert.equal(ia.walletIdFor('cap-other'), null);
  assert.equal(ia.info(wid).granted, 300000);
});

test('adopt: a cap minted FROM a funded cap draws from the SAME wallet (transitively); no-op otherwise', () => {
  const { ia } = mk();
  const wid = ia.fund('cap-member', 100000);
  assert.equal(ia.adopt('cap-member', 'cap-subchat'), wid);
  assert.equal(ia.walletIdFor('cap-subchat'), wid, 'child spends the member wallet');
  assert.equal(ia.adopt('cap-subchat', 'cap-subsub'), wid, 'grandchild adopts through the child');
  assert.equal(ia.walletIdFor('cap-subsub'), wid);
  assert.equal(ia.adopt('cap-unrelated', 'cap-x'), null, 'no wallet on the parent → nothing recorded');
  assert.equal(ia.walletIdFor('cap-x'), null);
});

test('registry survives a restart (durable) and NEVER writes a raw cap to disk (cap-hygiene)', () => {
  const { ia, file } = mk();
  const secret = 'cap-supersecret-swissnum-1234';
  ia.fund(secret, 250000, 'guest');
  ia.adopt(secret, 'cap-child-swiss-5678');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), 'raw member cap not on disk');
  assert.ok(!raw.includes('cap-child-swiss-5678'), 'raw child cap not on disk');
  const ia2 = makeInviteAllowances({ file }); // fresh instance = a server restart
  assert.equal(ia2.walletIdFor(secret), ia.walletIdFor(secret));
  assert.equal(ia2.walletIdFor('cap-child-swiss-5678'), ia.walletIdFor(secret));
});

// ── the server wiring shape end-to-end, with REAL purses: conservation across inviter → member ──
test('CONSERVATION (real purses): funding an invite moves µUSD inviter → member wallet, refused when short', () => {
  const { ia } = mk();
  const purses = new Map(); // the server's purse ledger, keyed like purseAt
  const purseAt = (k, seed = 0) => { if (!purses.has(k)) purses.set(k, makePurse(seed)); return purses.get(k); };
  const rootWallet = purseAt('wallet:root', 1000000);
  // grantFromRootWallet — the exact server wiring: assert-then-charge, deposit on mint
  const grant = uusd => {
    if (!rootWallet.canAfford(uusd)) return { ok: false, error: 'wallet cannot cover it' };
    rootWallet.debit(uusd);
    return { ok: true, deposit: cap => { const wid = ia.fund(cap, uusd); purseAt(`invite-wallet:${wid}`, 0).credit(uusd); } };
  };
  const g = grant(300000);
  assert.equal(g.ok, true);
  g.deposit('cap-new-member');
  const memberPurse = purseAt(`invite-wallet:${ia.walletIdFor('cap-new-member')}`, 0);
  assert.equal(rootWallet.balance(), 700000, 'inviter debited');
  assert.equal(memberPurse.balance(), 300000, 'member credited the same amount');
  // the member's SUB-CAP spends the same wallet
  ia.adopt('cap-new-member', 'cap-member-subchat');
  assert.equal(purseAt(`invite-wallet:${ia.walletIdFor('cap-member-subchat')}`, 0), memberPurse);
  // over-allowance: refused without mutating either ledger
  const over = grant(900000);
  assert.equal(over.ok, false);
  assert.equal(rootWallet.balance(), 700000, 'refused grant leaves the inviter untouched');
  assert.equal(rootWallet.balance() + memberPurse.balance(), 1000000, 'total conserved');
});
