// scrub-cap.test.mjs — SEC-13 unit guard for the CLIENT value-scrub (public/app.js `scrubCap`).
// The client scrub is defense-in-depth over the server scrubCaps: a swissnum / share token must NEVER reach
// the DOM (dan's red line). This broadens the old (bare-32-hex + #cap/#k/#agent) coverage to also redact
// url-borne share/download tokens (/dl/ /sites/ /clips/ /c/), any long hex run (≥24), and any base64url token
// run (≥22 — catches 24-char share tokens). We eval the REAL scrubCap expression out of app.js (it depends
// only on String, no DOM) so this tracks the shipped code, not a copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'public/app.js'), 'utf8');
const m = src.match(/const scrubCap = s => String\(s == null \? '' : s\)([\s\S]*?);\n/);
assert(m, 'could not locate the scrubCap expression in public/app.js');
// eslint-disable-next-line no-eval
const scrubCap = eval('(s => String(s == null ? "" : s)' + m[1] + ')');

test('SEC-13: the new token shapes are redacted before they can reach the DOM', () => {
  const leaky = [
    ['#cap fragment', 'open #cap=0123456789abcdef0123456789abcdef', '0123456789abcdef'],
    ['#agent fragment', 'link #agent=abcd1234efgh', 'abcd1234efgh'],
    ['#fork fragment', 'fork #fork=aaaabbbbccccddddeeee', 'aaaabbbbccccddddeeee'],
    ['/dl/ path token', 'grab https://x/dl/9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['/sites/ path token', 'see https://host/sites/deadbeef01', 'deadbeef01'],
    ['/clips/ path token', 'clip https://host/clips/abcd1234', 'abcd1234'],
    ['48-hex tool-share', 'bare ' + 'a'.repeat(48), 'a'.repeat(48)],
    ['32-hex swissnum', 'bare ' + '0123456789abcdef'.repeat(2), '0123456789abcdef0123456789abcdef'],
    ['24-char base64url share token', 'token Xk9_aB3cD4eF5gH6iJ7kL8mN', 'Xk9_aB3cD4eF5gH6iJ7kL8mN'],
  ];
  for (const [label, input, secret] of leaky) {
    const out = scrubCap(input);
    assert(!out.includes(secret), `LEAK (${label}): "${out}" still contains the secret`);
    assert(/«(redacted|swissnum|token)»/.test(out), `no redaction marker for ${label}: "${out}"`);
  }
});

test('SEC-13: ordinary prose and short ids are not over-redacted', () => {
  for (const ok of ['hello world', 'the quick brown fox', 'chat-1234', 'v12 applied', 'user@example.com', 'Component Studio sort']) {
    assert.strictEqual(scrubCap(ok), ok, `over-redacted benign text: "${ok}"`);
  }
});
