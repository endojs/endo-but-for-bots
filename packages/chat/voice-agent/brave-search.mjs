// brave-search.mjs — web search via the Brave Search API, as a READ-ONLY field-agent
// capability. Returns the top results (title, url, snippet) so the agent can FIND pages,
// then read one with fetchUrl / browseWeb. The API key is read from a config file or env,
// NEVER from code or chat (same pattern as email-smtp.mjs).
//   key: ~/.config/field-agent/brave.json  →  { "apiKey": "BSA…" }   (or env BRAVE_API_KEY)
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from './field-config.mjs';
import { getSecret } from './asks-store.mjs';

// Personal-family path resolves through field-config (byte-identical default on the NUC;
// rebases onto FIELD_PERSONAL_ROOT when the personal volume is mounted).
const CFG = path.join(CONFIG_DIR, 'brave.json');
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// key sources, in order: BRAVE_API_KEY env → the named key vault ('brave-api-key', which
// the in-chat secret-ask flow writes to) → brave.json (back-compat).
const getKey = () => {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY.trim();
  const vault = getSecret('brave-api-key'); if (vault) return vault;
  try { return String(JSON.parse(fs.readFileSync(CFG, 'utf8')).apiKey || '').trim(); } catch { return ''; }
};

const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

export const braveSearch = async (query, { count = 6 } = {}) => {
  const q = String(query || '').trim();
  if (!q) return harden({ ok: false, error: 'empty query' });
  const key = getKey();
  if (!key) return harden({ ok: false, error: 'no Brave API key yet. To get one: call askOperator with a SECRET question whose key is "brave-api-key" (e.g. {q:"Your Brave Search API key", type:"secret", key:"brave-api-key"}) so dan can paste it securely in-chat — it lands in the key vault and search works immediately. (Keys at https://brave.com/search/api/.)' });
  const n = Math.min(20, Math.max(1, Number(count) || 6));
  try {
    const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&count=${n}`;
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return harden({ ok: false, error: `Brave ${r.status}: ${(await r.text().catch(() => '')).slice(0, 150)}` });
    const j = await r.json();
    const results = (((j.web && j.web.results) || []).slice(0, n)).map(x => harden({ title: strip(x.title), url: x.url, description: strip(x.description) }));
    return harden({ ok: true, query: q, results });
  } catch (e) { return harden({ ok: false, error: /** @type {Error} */ (e).message }); }
};
harden(braveSearch);
