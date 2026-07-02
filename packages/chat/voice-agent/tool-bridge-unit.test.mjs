// tool-bridge-unit.test.mjs — T-TEST-3 · the model-provider seam (packages/ocapn-noise/tool-bridge.mjs:
// callLLM + buildUserContent).
//
// FINDING / scope note: the T-TEST-3 ticket describes this file as "the confined-toolbox seam" (only
// granted tools reachable, args marshalled, no ambient scope leak). That is NOT this file — the confined
// toolbox is codemode.mjs's lexical scope. THIS file (per its own header) is the callLLM provider dispatch
// (gemma/Anthropic/OpenRouter) plus buildUserContent multimodal assembly; the retired TOOL_CALL: text loop
// used to live here. So the load-bearing behavior we CAN assert in isolation is:
//   • the API-key read precedence (env → vault → ~/.env) and, critically, that a key is NEVER returned or
//     surfaced in an error string (cap/secret hygiene);
//   • provider routing dispatch (anthropic:/openrouter:/local) and graceful no-key handling (returns an
//     {error} object, never throws);
//   • buildUserContent turn assembly (plain string vs multimodal blocks).
//
// Hermetic: the module resolves CONFIG_DIR/HOST_ENV_FILE from env at load, so we set those to mkdtemp paths
// BEFORE a dynamic import, and stub globalThis.fetch (no network). The key-resolution caches are one-shot per
// module load, so we exercise ONE precedence path per provider (env-first via OpenRouter; no-key hygiene via
// Anthropic) — see the gap note in the final report.

import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- set up a hermetic config/env before importing the module under test -------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-bridge-unit-'));
fs.mkdirSync(path.join(dir, 'config', 'secrets'), { recursive: true });
const CONFIG_DIR = path.join(dir, 'config');
const HOST_ENV_FILE = path.join(dir, 'env');

// Vault keys (env absent → these are the fallback). Distinct sentinels so we can prove which tier won.
fs.writeFileSync(path.join(CONFIG_DIR, 'secrets', 'openrouter-api-key'), 'OR_VAULT_KEY\n');
fs.writeFileSync(path.join(CONFIG_DIR, 'secrets', 'anthropic-api-key'), 'AN_VAULT_KEY\n');
// ~/.env fallback carries a DIFFERENT anthropic key, so we can prove the vault beats ~/.env.
fs.writeFileSync(HOST_ENV_FILE, 'ANTHROPIC_API_KEY=AN_ENVFILE_KEY\n');

process.env.FIELD_CONFIG_DIR = CONFIG_DIR;
process.env.HOST_ENV_FILE = HOST_ENV_FILE;
delete process.env.FIELD_PERSONAL_ROOT;
// env-tier for OpenRouter (must WIN over the vault file above); anthropic env is left UNSET so the vault wins.
process.env.OPENROUTER_API_KEY = 'OR_ENV_KEY';
delete process.env.ANTHROPIC_API_KEY;

const { callLLM, buildUserContent } = await import('../../ocapn-noise/tool-bridge.mjs');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

// A fetch stub that records the request headers/body and returns a fixed OK response for whichever
// provider shape is dialed. NEVER hits the network.
const installFetch = () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {}, body: opts.body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ type: 'text', text: 'hi' }], // Anthropic shape
          choices: [{ message: { content: 'hi' } }], // OpenAI/OpenRouter shape
          usage: { input_tokens: 1, output_tokens: 2, prompt_tokens: 1, completion_tokens: 2 },
        };
      },
      async text() { return ''; },
      clone() { return { async text() { return ''; } }; },
    };
  };
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
};

// ---- buildUserContent (pure) ---------------------------------------------

test('buildUserContent: plain string when there are no attachments', () => {
  assert.equal(buildUserContent('hello'), 'hello');
  assert.equal(buildUserContent('', []), '');
  assert.equal(buildUserContent(null), '');
});

test('buildUserContent: text attachments are inlined into the text part', () => {
  const out = buildUserContent('question', [{ kind: 'text', name: 'notes.txt', text: 'FILE BODY' }]);
  assert.equal(typeof out, 'string');
  assert.ok(out.startsWith('question'));
  assert.ok(out.includes('[attached file: notes.txt]'));
  assert.ok(out.includes('FILE BODY'));
});

test('buildUserContent: images produce a multimodal block array; non-image/empty attachments are filtered', () => {
  const out = buildUserContent('look', [
    { kind: 'image', url: 'data:image/png;base64,AAAA' },
    { kind: 'image' }, // no url → filtered
    { kind: 'text' }, // no text → filtered
    { kind: 'bogus', url: 'x' }, // wrong kind → filtered
  ]);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2); // one text block + one image block
  assert.equal(out[0].type, 'text');
  assert.equal(out[1].type, 'image_url');
  assert.equal(out[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('buildUserContent: an image with no accompanying text still gets a placeholder text block', () => {
  const out = buildUserContent('', [{ kind: 'image', url: 'u' }]);
  assert.equal(out[0].text, '(see attached image)');
});

// ---- callLLM key precedence + hygiene ------------------------------------

test('callLLM(openrouter): env key WINS over the vault file, and the key never appears in the RESULT', async () => {
  const f = installFetch();
  try {
    const res = await callLLM([{ role: 'user', content: 'hi' }], 'openrouter:openai/gpt-4o-mini');
    // the key that hit the wire is the ENV one (env → vault → ~/.env precedence)
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].headers.authorization, 'Bearer OR_ENV_KEY');
    assert.notEqual(f.seen[0].headers.authorization, 'Bearer OR_VAULT_KEY');
    // cap/secret hygiene: neither key is anywhere in the returned object
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes('OR_ENV_KEY'));
    assert.ok(!dump.includes('OR_VAULT_KEY'));
    assert.equal(res.text, 'hi');
  } finally {
    f.restore();
  }
});

test('callLLM(anthropic): with no ANTHROPIC_API_KEY in env, the VAULT key beats the ~/.env key on the wire', async () => {
  const f = installFetch();
  try {
    const res = await callLLM([{ role: 'user', content: 'hi' }], 'anthropic:claude-opus-4-8');
    assert.equal(f.seen.length, 1);
    // vault (AN_VAULT_KEY) must win over the ~/.env fallback (AN_ENVFILE_KEY)
    assert.equal(f.seen[0].headers['x-api-key'], 'AN_VAULT_KEY');
    // hygiene: no key material in the returned object
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes('AN_VAULT_KEY'));
    assert.ok(!dump.includes('AN_ENVFILE_KEY'));
    assert.equal(res.text, 'hi');
  } finally {
    f.restore();
  }
});

test('callLLM(anthropic): a BYO apiKey override is used verbatim and still never leaks into the result', async () => {
  const f = installFetch();
  try {
    const res = await callLLM([{ role: 'user', content: 'hi' }], 'anthropic:claude-opus-4-8', { apiKey: 'BYO_USER_KEY' });
    assert.equal(f.seen[0].headers['x-api-key'], 'BYO_USER_KEY');
    assert.ok(!JSON.stringify(res).includes('BYO_USER_KEY'));
  } finally {
    f.restore();
  }
});

test('callLLM(local gemma): returns { text, usage } from the OpenAI-shaped response, no key needed', async () => {
  const f = installFetch();
  try {
    const res = await callLLM([{ role: 'user', content: 'hi' }], 'default');
    assert.equal(res.text, 'hi');
    assert.deepEqual(res.usage, { input_tokens: 1, output_tokens: 2, prompt_tokens: 1, completion_tokens: 2 });
    // local model call carries no Authorization/x-api-key header
    assert.equal(f.seen[0].headers.authorization, undefined);
    assert.equal(f.seen[0].headers['x-api-key'], undefined);
  } finally {
    f.restore();
  }
});
