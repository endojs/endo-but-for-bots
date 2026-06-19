// anonymize.test.mjs — proves the fail-closed guarantee (Task 2 acceptance). No live model.
//   node --test eval/anonymize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, findSecret, findPII } from './anonymize.mjs';

// A fake 64-hex "swissnum" and a #cap fragment — must NEVER survive.
const FAKE_SWISS = 'a'.repeat(64);
const SECRETS = [
  `here is my cap #cap=${FAKE_SWISS}`,
  `the swissnum is ${FAKE_SWISS}`,
  `token deadbeefdeadbeef`,
  `connect with bearer ABCDEFGH1234`,
  `-----BEGIN OPENSSH PRIVATE KEY-----\nxxx`,
];

test('secrets are detected', () => { for (const s of SECRETS) assert.ok(findSecret(s), s); });

test('secret-bearing prompts DROP (never emit), even with a gemma available', async () => {
  const gemma = async () => 'totally clean rewrite'; // a "clean" rewrite must not rescue a secret input
  for (const s of SECRETS) {
    const r = await anonymize(s, { gemma });
    assert.equal(r.ok, false, s);
    assert.match(r.reason, /^secret:/);
  }
});

test('PII prompt DROPS fail-closed when gemma is unavailable', async () => {
  const r = await anonymize('After I talked to Mansi she referred me to a contract lawyer', { gemma: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /pii-needs-gemma/);
});

test('PII prompt is generalized when gemma is up AND output re-scans clean', async () => {
  const gemma = async () => 'Summarize advice received from a referred professional';
  const r = await anonymize('After I talked to Mansi she referred me to a contract lawyer', { gemma });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'gemma-generalized');
  assert.equal(findPII(r.text).length, 0);
});

test('a gemma rewrite that LEAKS a name/secret is rejected (re-scan fail-closed)', async () => {
  const leakName = async () => 'Talk to Mansi about it'; // still names a person
  const r1 = await anonymize('I met Mansi yesterday', { gemma: leakName });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'gemma-output-still-pii');
  const leakSecret = async () => `use #cap=${'b'.repeat(64)}`;
  const r2 = await anonymize('I talked to Bob about the key', { gemma: leakSecret });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'gemma-output-leaked-secret');
});

test('a clean technical prompt passes with no gemma', async () => {
  const r = await anonymize('Look up which dinosaurs had the longest necks and summarize', { gemma: null });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'clean');
});
