// dist-trust.test.mjs — unit coverage for the distribution-trust social-collateral layer (dist-trust.mjs).
import '@endo/init'; // lockdown + harden first
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDistTrust } from './dist-trust.mjs';

const setup = () => makeDistTrust({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dtrust-')), 'dt.json'), rootId: 'root' });
const SRC = "(e,p)=>e.h('div',null,'hi')";
const SRC2 = "(e,p)=>e.h('div',null,'edited')";

test('root is always a reviewer; strangers are not', () => {
  const dt = setup();
  assert.equal(dt.isReviewer('root'), true);
  assert.equal(dt.isReviewer('u:alice'), false);
});

test('trust flows outward from root along grant edges; each grant records the voucher', () => {
  const dt = setup();
  assert.ok(dt.grantReviewer('root', 'u:alice').ok, 'root vouches for alice');
  assert.equal(dt.isReviewer('u:alice'), true, 'alice is now a reviewer');
  assert.ok(dt.grantReviewer('u:alice', 'u:bob').ok, 'alice (a reviewer) vouches for bob — maximal outward flow');
  assert.equal(dt.isReviewer('u:bob'), true, 'bob is a reviewer via alice→root chain');
  assert.equal(dt.grantReviewer('u:mallory', 'u:eve').ok, false, 'a non-reviewer cannot vouch');
  const graph = dt.reviewers();
  assert.equal(graph.find(r => r.id === 'u:bob').grantedBy, 'u:alice', 'the vouching edge is recorded (social collateral)');
});

test('revoking a reviewer cascades — those whose chain ran through them lose trust', () => {
  const dt = setup();
  dt.grantReviewer('root', 'u:alice'); dt.grantReviewer('u:alice', 'u:bob');
  assert.ok(dt.revokeReviewer('root', 'u:alice').ok, 'root revokes alice');
  assert.equal(dt.isReviewer('u:alice'), false, 'alice loses trust');
  assert.equal(dt.isReviewer('u:bob'), false, 'bob CASCADES (his chain ran through alice)');
  assert.equal(dt.revokeReviewer('u:mallory', 'u:bob').ok, false, 'a stranger cannot revoke');
});

test('only the voucher (or root) can revoke a reviewer', () => {
  const dt = setup();
  dt.grantReviewer('root', 'u:alice'); dt.grantReviewer('root', 'u:carol'); dt.grantReviewer('u:alice', 'u:bob');
  assert.equal(dt.revokeReviewer('u:carol', 'u:bob').ok, false, 'carol did not vouch for bob — cannot revoke');
  assert.ok(dt.revokeReviewer('u:alice', 'u:bob').ok, 'alice (the voucher) can');
});

test('approval is pinned to content — an edit does NOT inherit it', () => {
  const dt = setup();
  dt.grantReviewer('root', 'u:alice');
  assert.ok(dt.approve('u:alice', 'fork-1', 2, SRC).ok, 'alice approves fork-1 @ this source');
  assert.equal(dt.approvalFor('fork-1', SRC).approved, true, 'the approved source is approved');
  assert.equal(dt.approvalFor('fork-1', SRC2).approved, false, 'an EDITED source is NOT approved (content-pinned)');
  assert.equal(dt.approvalFor('fork-2', SRC).approved, false, 'a different fork is not approved');
});

test('a non-reviewer cannot approve; revoking an approval un-approves', () => {
  const dt = setup();
  assert.equal(dt.approve('u:mallory', 'fork-1', 1, SRC).ok, false, 'stranger cannot approve');
  dt.grantReviewer('root', 'u:alice'); dt.approve('u:alice', 'fork-1', 1, SRC);
  assert.equal(dt.approvalFor('fork-1', SRC).approved, true);
  assert.ok(dt.revokeApproval('u:alice', 'fork-1', SRC).ok, 'approver revokes');
  assert.equal(dt.approvalFor('fork-1', SRC).approved, false, 'no longer approved');
});

test('an approval goes VOID if its approver later loses trust', () => {
  const dt = setup();
  dt.grantReviewer('root', 'u:alice'); dt.approve('u:alice', 'fork-1', 1, SRC);
  assert.equal(dt.approvalFor('fork-1', SRC).approved, true, 'approved while alice is trusted');
  dt.revokeReviewer('root', 'u:alice');
  const a = dt.approvalFor('fork-1', SRC);
  assert.equal(a.approved, false, 'approval is void once the approver loses trust (live, not a snapshot)');
  assert.equal(a.staleReviewer, true, 'flagged as a stale-reviewer approval');
});
