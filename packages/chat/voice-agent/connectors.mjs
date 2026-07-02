// connectors.mjs — Phase 3 Lane A: "build a tool in-system that needs a secret." A connector is a
// host-side authenticated-HTTP capability the OWNER configures (name, baseUrl, auth header template,
// and the NAME of a vault secret). The agent calls it as a tool; the API key is resolved from the
// named key vault and injected into the request SERVER-SIDE — it never enters the agent's scope, the
// connector record, the transcript, or the DOM (the `op run` runtime-injection pattern from the
// research). Connectors are grantable (the `connectors` power) + revocable (remove).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CONFIG_DIR } from './field-config.mjs';
import { writeJsonAtomic } from './write-json-atomic.mjs';

// Personal-family path resolves through field-config (byte-identical default on the NUC;
// rebases onto FIELD_PERSONAL_ROOT when the personal volume is mounted).
const STORE = process.env.CONNECTORS_STORE || path.join(CONFIG_DIR, 'connectors.json');

// makeConnectors({ getSecret, ssrfOk, fetchImpl }) → registry + call(). The secret VALUE is never
// stored here — only `secretName`, a reference into the named vault resolved at call time.
export const makeConnectors = ({ getSecret, ssrfOk = null, fetchImpl = fetch } = {}) => {
  const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')).connectors || []; } catch { return []; } };
  const save = cs => { try { writeJsonAtomic(STORE, { connectors: cs }, { pretty: true, mode: 0o600 }); } catch { /* best effort */ } }; // INT-1: torn-write-safe (holds connector secrets)

  const get = id => load().find(c => c.id === String(id)) || null;
  // list is safe to expose: it reveals what's connected + whether a key is present, NEVER the key.
  // costUusd = market rate per call (µUSD); commissionPct = our margin (default 1%). billed = both → profit.
  const list = () => load().map(c => ({ id: c.id, name: c.name, baseUrl: c.baseUrl, readOnly: !!c.readOnly, needsKey: !!c.secretName, hasKey: !!(c.secretName && getSecret(c.secretName)), description: c.description || '', costUusd: c.costUusd || 0, commissionPct: c.commissionPct == null ? 1 : c.commissionPct, resale: c.resale || 'unknown' }));
  // What a call bills the caller's purse: market rate × (1 + commission). 0 cost = free tool.
  const billedFor = c => { if (!c || !c.costUusd) return 0; const pct = c.commissionPct == null ? 1 : c.commissionPct; return Math.ceil(Number(c.costUusd) * (1 + pct / 100)); };
  const add = ({ name, baseUrl, header, valueTemplate, secretName, readOnly, description, costUusd, commissionPct, resale }) => {
    const id = `conn-${crypto.randomBytes(5).toString('hex')}`;
    const rec = {
      id, name: String(name || id).slice(0, 80), baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
      header: String(header || 'Authorization').slice(0, 80), valueTemplate: String(valueTemplate || 'Bearer {{secret}}').slice(0, 200),
      secretName: String(secretName || '').replace(/[^\w.-]/g, '_').slice(0, 60), readOnly: readOnly !== false,
      description: String(description || '').slice(0, 300),
      costUusd: Math.max(0, Math.round(Number(costUusd) || 0)), // market rate per call (µUSD)
      commissionPct: commissionPct == null ? 1 : Math.max(0, Number(commissionPct)), // our margin (default 1%)
      resale: ['ok', 'byo', 'prohibited', 'unknown'].includes(resale) ? resale : 'unknown', // ToS resale status
      createdAt: new Date().toISOString(),
    };
    save(load().concat(rec));
    return { ok: true, id: rec.id, name: rec.name };
  };
  const remove = id => { save(load().filter(c => c.id !== String(id))); return { ok: true, id: String(id) }; };

  // Call a connector. The agent supplies path/method/query/body; the secret is injected here.
  const call = async (id, { path: p = '', method = 'GET', query, body } = {}) => {
    const c = get(id); if (!c) return { ok: false, error: 'no such connector' };
    const m = c.readOnly ? 'GET' : String(method || 'GET').toUpperCase(); // read-only connectors are GET-only
    let url = c.baseUrl + (p ? (String(p).startsWith('/') ? p : `/${p}`) : '');
    if (query && typeof query === 'object') { const qs = new URLSearchParams(query).toString(); if (qs) url += (url.includes('?') ? '&' : '?') + qs; }
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'connector base URL must be http(s)' };
    if (ssrfOk && !(await ssrfOk(url))) return { ok: false, error: 'blocked host (private/loopback) — connectors call public services only' };
    const headers = { accept: 'application/json' };
    if (c.secretName) {
      const secret = getSecret(c.secretName);
      if (!secret) return { ok: false, error: `"${c.name}" has no API key yet — the owner needs to add the "${c.secretName}" secret`, needsKey: c.secretName };
      headers[c.header] = c.valueTemplate.replace('{{secret}}', secret); // injected server-side; never returned
    }
    const opts = { method: m, headers };
    if (m !== 'GET' && body !== undefined) { headers['content-type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
    try { opts.signal = AbortSignal.timeout(30000); } catch { /* older runtimes */ }
    let r; try { r = await fetchImpl(url, opts); } catch (e) { return { ok: false, error: (e && e.message) || 'request failed' }; }
    const text = (await r.text()).slice(0, 40000);
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  };

  return { list, get, add, remove, call, billedFor };
};
