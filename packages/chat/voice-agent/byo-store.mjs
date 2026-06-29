// byo-store.mjs — "bring your own inference provider". An invited user can connect THEIR OWN anthropic/
// openrouter account (key + model) so their turns run on their account, UNLIMITED, bypassing the owner's
// metered allowance. Cap-hygiene: the store holds only {provider, model} keyed by a HASH of the user's cap;
// the API KEY itself lives in the named secret vault (storeNamedSecret/getSecret), never here, never in the
// DOM/transcript/URL. Plain Node so it imports from both the SES server and tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROVIDERS = new Set(['anthropic', 'openrouter']); // paid, per-account providers a user can BYO

export const makeByoStore = ({ file, getSecret, storeNamedSecret } = {}) => {
  const capHash = cap => crypto.createHash('sha256').update(`byo:${String(cap || '')}`).digest('hex').slice(0, 32);
  const secretName = cap => `byo-${capHash(cap)}`; // the vault key name for this user's API key
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { users: {} }; } };
  const write = d => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); };

  // connect (or update) a user's own provider. The key is diverted to the vault; only {provider, model} persist.
  const set = (cap, { provider, model, key } = {}) => {
    const p = String(provider || '').toLowerCase();
    if (!PROVIDERS.has(p)) return { ok: false, error: `provider must be one of: ${[...PROVIDERS].join(', ')}` };
    if (key && String(key).trim()) storeNamedSecret(secretName(cap), String(key).trim()); // → vault (0600), never echoed
    if (!getSecret(secretName(cap))) return { ok: false, error: 'no API key on file — provide your key to connect' };
    const d = read();
    d.users[capHash(cap)] = { provider: p, model: String(model || '').trim() || (p === 'anthropic' ? 'claude-sonnet-4-6' : 'openai/gpt-4o'), updatedAt: new Date().toISOString() };
    write(d);
    return { ok: true, provider: p, model: d.users[capHash(cap)].model };
  };
  // the active config for a turn: { provider, model, modelId, key } or null. modelId is the callLLM-ready
  // `provider:model`; key is read from the vault on demand (never persisted in this store).
  const forTurn = cap => {
    const rec = read().users[capHash(cap)];
    if (!rec) return null;
    const key = getSecret(secretName(cap));
    if (!key) return null; // key was cleared — fall back to the owner's metered providers
    return { provider: rec.provider, model: rec.model, modelId: `${rec.provider}:${rec.model}`, key };
  };
  // status for the UI: connected + provider + model, but NEVER the key (only whether one is on file).
  const status = cap => { const rec = read().users[capHash(cap)]; const hasKey = !!getSecret(secretName(cap)); return { connected: !!(rec && hasKey), provider: rec?.provider || null, model: rec?.model || null, hasKey }; };
  const clear = cap => { const d = read(); delete d.users[capHash(cap)]; write(d); try { storeNamedSecret(secretName(cap), ''); } catch { /* */ } return { ok: true }; };

  return { set, forTurn, status, clear, PROVIDERS: [...PROVIDERS] };
};
