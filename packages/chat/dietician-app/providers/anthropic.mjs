// providers/anthropic.mjs — the package's OWN plain-node model adapter, so a portable instance can judge
// without importing the SES voice-agent delegate. Mirrors delegate.mjs opusComplete: reads ANTHROPIC_API_KEY
// (env → named vault 'anthropic-api-key' → ~/.env), POSTs the Messages API, returns the reply TEXT only.
// The key is read server-side, never returned/logged. grunt.mjs may instead inject the real opusComplete.
import fsp from 'node:fs/promises';
import { getSecret } from '../../voice-agent/asks-store.mjs';

const API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.DIET_JUDGE_MODEL || 'claude-opus-4-8';

let cachedKey;
const getKey = async () => {
  if (cachedKey) return cachedKey;
  if (process.env.ANTHROPIC_API_KEY) { cachedKey = process.env.ANTHROPIC_API_KEY.trim(); return cachedKey; }
  const vault = getSecret('anthropic-api-key'); if (vault) { cachedKey = vault; return cachedKey; }
  try {
    const env = await fsp.readFile(`${process.env.HOME || '/home/dan'}/.env`, 'utf8');
    const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) { cachedKey = m[1].trim().replace(/^["']|["']$/g, ''); return cachedKey; }
  } catch { /* none */ }
  return '';
};

// complete({system, prompt, maxTokens, signal}) → reply text ('' on any failure → judge falls back to UNKNOWN).
export const makeAnthropicComplete = ({ model = DEFAULT_MODEL } = {}) => async ({ system = '', prompt = '', maxTokens = 900, signal } = {}) => {
  const key = await getKey();
  if (!key) return '';
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: String(prompt || '') }] }),
      signal,
    });
    if (!res.ok) return '';
    const j = await res.json();
    return (j.content || []).map(b => b.text || '').join('').trim();
  } catch { return ''; }
};

export const hasKey = async () => !!(await getKey());
