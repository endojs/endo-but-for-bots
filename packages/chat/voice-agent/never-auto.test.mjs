// never-auto.test.mjs — regression proof for the auto-confirm denylist (R5).
//
// The hole (fixed, agent-caps.mjs): NEVER_AUTO held only {home-assistant, accept-invite}, so external /
// high-authority proposal types could be "don't ask again"-remembered and then auto-fire without a
// confirmation card: email (outbound send), buffer-post/blast/delete (social publish), subagent (grants a
// sub-agent the HOST shell), system-prompt (self-modification), give-kazputer + kazputer-* (provisioning).
// This contradicts dan's "email SEND behind confirm" + endowment-moment rule. All are now in NEVER_AUTO.
//
// Run: node --test never-auto.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_AUTO } from './agent-caps.mjs';

test('every external / high-authority proposal type is in the auto-confirm denylist', () => {
  for (const t of ['home-assistant', 'accept-invite', 'email', 'buffer-post', 'buffer-blast', 'buffer-delete', 'subagent', 'system-prompt', 'give-kazputer', 'kazputer-setting', 'kazputer-coins']) {
    assert.ok(NEVER_AUTO.has(t), `${t} must never be auto-confirmable`);
  }
});

test('the denylist gate logic refuses to remember/auto-fire a NEVER_AUTO kind', () => {
  // mirrors the exact isAutoConfirmed / addAutoRule gates in agent-caps.mjs against the REAL exported set.
  const rules = [{ agent: 'root', kind: 'email' }]; // even if a rule somehow existed…
  const isAutoConfirmed = (agent, kind) => !NEVER_AUTO.has(kind) && rules.some(r => r.agent === agent && r.kind === kind);
  const addAutoRule = (agent, kind) => { if (NEVER_AUTO.has(kind)) return false; return true; };

  assert.equal(isAutoConfirmed('root', 'email'), false, 'email must not auto-fire even with a stale rule');
  assert.equal(isAutoConfirmed('root', 'subagent'), false, 'subagent (host shell) must not auto-fire');
  assert.equal(addAutoRule('root', 'email'), false, 'addAutoRule must refuse to record an email rule');
  assert.equal(addAutoRule('root', 'system-prompt'), false, 'addAutoRule must refuse a self-mod rule');
  // a benign, remember-able kind is unaffected
  assert.equal(addAutoRule('root', 'note-edit'), true, 'a benign kind can still be remembered');
});
