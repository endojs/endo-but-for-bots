// dietician.mjs — the field agent's bridge to the agent-dietician persona's restaurant
// pipeline, so the MAIN bot (chat/voice intake) can drive it: scan an area's restaurants,
// evaluate them against Alexa's binding diet spec, rebuild the safe-eats map, and refresh
// the published browsing sites (eats-guide — the all-cities navigator the dietician just
// built — and disneyland-food-guide).
//
// We SSH-DRIVE the persona's PROVEN Python tools rather than reimplement them: the Google
// Places key + the scripts stay inside the persona (cap-hygiene — the field agent never
// holds the key). Designation is by this held cap (the persona host), not an ambient string.
// Publishing a site is OUTWARD-facing, so it is exposed only as a confirmable PROPOSAL
// (the field agent proposes; dan confirms; only then does it git-push → archua-deploy).
//
// Schema (the persona's migrate.py splits them so verdicts are re-derivable per person):
//   places/<slug>.json            — place metadata + cached_menu (reusable across people)
//   evaluations/alexa/<slug>.json — Alexa's per-person verdict (what the guides READ)
import { execFile } from 'node:child_process';
import { opusComplete } from './delegate.mjs';

const HOST = process.env.DIETICIAN_HOST || 'agent@10.89.0.8';
const EAT = '~/eating-out';
// the dietician's deployed browsing sites (git push → archua-deploy → Tailnet/chu URL)
const SITES = {
  'eats-guide': { dir: '~/eats-guide', title: 'Eats Guide (all cities, for Alexa)' },
  'disneyland-food-guide': { dir: '~/disneyland-food-guide', title: 'Disneyland Food Guide' },
};
export const DIET_SITES = harden(Object.keys(SITES));
const CITY_RE = /^[a-z][a-z-]{1,30}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const b64 = s => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// Pass the command as ONE arg (NOT `bash -lc <cmd>`): ssh joins multiple remote args with
// spaces and the remote shell re-parses, which breaks `bash -lc 'cd … && …'` (the cd no-ops to
// $HOME). A single command arg runs in the remote login shell as written (cd/~/pipes all work).
const ssh = (cmd, timeoutMs = 120000) => new Promise(resolve =>
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, '--', cmd],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    (err, so, se) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(so || ''), stderr: String(se || '').slice(0, 4000) })));
// run a python3 script on the persona via base64 (no quoting hazards — multi-line scripts work).
const runPy = (script, timeoutMs = 30000) => ssh(`echo ${b64(script)} | base64 -d | python3`, timeoutMs);

// write a JSON file on the persona via base64 (no quoting hazards). path is validated by caller.
const writeJson = async (relPath, obj) => ssh(`mkdir -p "$(dirname ~/${relPath})" && echo ${b64(JSON.stringify(obj, null, 2))} | base64 -d > ~/${relPath}`, 20000);

// ── 1) SCAN — sweep.py <city> (Google Places; key sourced from the persona's .env) → candidates.
//    sweep dedupes against the existing DB + writes /tmp/<city>-top.json (read by evaluateArea).
export const scanArea = async (city) => {
  const c = String(city || '').trim().toLowerCase();
  if (!CITY_RE.test(c)) return harden({ ok: false, error: 'city must be a lowercase slug, e.g. "berlin", "oakland", "san-francisco"' });
  // sweep emits the candidate JSON to stdout; tee it to /tmp/<city>-top.json (the persona's
  // convention) so dietEvaluateArea can pick the candidates up.
  const r = await ssh(`cd ${EAT} && set -a; . ~/.env 2>/dev/null; set +a; python3 sweep.py ${c} | tee /tmp/${c}-top.json`, 180000);
  if (!r.ok) return harden({ ok: false, error: `${(r.stderr || 'sweep failed').slice(0, 240)} — is "${c}" defined in sweep.py CITIES?` });
  let cands = []; const s = r.stdout; const a = s.indexOf('['); const b = s.lastIndexOf(']'); try { cands = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : (s.trim() || '[]')); } catch { cands = []; }
  return harden({ ok: true, city: c, count: cands.length,
    candidates: cands.slice(0, 80).map(x => ({ name: x.name, address: x.address, slug: x.slug || slugify(x.name), place_id: x.place_id, primary_type: x.primary_type })),
    note: cands.length ? `Found ${cands.length} new candidate(s) for ${c}. Use dietEvaluateArea to judge them against Alexa's diet, then dietRefreshSite to publish.` : `No new candidates for ${c} (already swept, or none matched).` });
};

let specCache;
const readSpec = async () => { if (specCache !== undefined) return specCache; const r = await ssh('cat ~/family-diets/alexa.md', 20000); specCache = r.ok ? r.stdout.slice(0, 6000) : ''; return specCache; };

// the persona's evaluation rubric (mirrors gen_prompts.py) — the model returns ONLY this JSON object.
const EVAL_SYS = spec => [
  'You are evaluating ONE restaurant for whether **Alexa** can safely eat there. Her binding diet spec:',
  '--- BEGIN SPEC ---', spec || '(spec unavailable — be conservative)', '--- END SPEC ---',
  'Read the menu provided. Pick a verdict:',
  '- VIABLE — at least one orderable dish (possibly with simple mods) is clean for her, and the kitchen suggests cook-to-order.',
  '- BORDERLINE — viable only with major modification, call-ahead, or off-menu requests.',
  '- SKIP — nothing safely orderable, or the cuisine/format is fundamentally wrong.',
  '- UNKNOWN — the menu provided is not a real/usable menu.',
  'Be SKEPTICAL and honest — chains pre-marinate proteins; delis default to cured meats + aged cheese; Middle-Eastern places default to garlic/tahini/yogurt. Do NOT manufacture options. When unsure, prefer SKIP or UNKNOWN.',
  'Return ONLY a JSON object (no prose, no code fence) with exactly these keys:',
  '{"verdict":"VIABLE|BORDERLINE|SKIP|UNKNOWN","cuisine":"<what they actually serve>","summary":"1-2 honest sentences","promising_dishes":[{"name":"...","modifications":"...","residual_risk":"..."}],"avoid_outright":["dish — short reason"],"kitchen_flexibility":"1 sentence"}',
].join('\n');

const parseVerdict = txt => {
  const s = String(txt || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(s.slice(a, b + 1)); return (o && /^(VIABLE|BORDERLINE|SKIP|UNKNOWN)$/.test(o.verdict)) ? o : null; } catch { return null; }
};

// ── 2) EVALUATE — for up to `limit` not-yet-evaluated candidates of the LAST scan of <city>:
//    find + read the menu (injected web tools), judge vs the spec (STRONG model, Opus; falls
//    back to the local model), and write BOTH place metadata + Alexa's verdict in the exact
//    schema the guides read. Idempotent (skips places already evaluated). tools: {webSearch, fetchUrl, browse, localModel}.
export const evaluateArea = async ({ city, limit = 3, tools = {}, onStep = () => {}, signal } = {}) => {
  const c = String(city || '').trim().toLowerCase();
  if (!CITY_RE.test(c)) return harden({ ok: false, error: 'city must be a slug, e.g. "berlin"' });
  const lim = Math.max(1, Math.min(8, Number(limit) || 3));
  // candidates from the last scan of this city (sweep wrote /tmp/<city>-top.json)
  const cr = await ssh(`cat /tmp/${c}-top.json 2>/dev/null`, 15000);
  let cands = []; try { cands = JSON.parse(cr.stdout.trim() || '[]'); } catch { cands = []; }
  if (!cands.length) return harden({ ok: false, error: `No fresh candidates for ${c} — run dietScanArea("${c}") first.` });
  // which already have an Alexa eval?
  const ev = await ssh(`ls ${EAT}/evaluations/alexa/ 2>/dev/null`, 15000);
  const done = new Set(ev.stdout.split('\n').map(s => s.replace(/\.json$/, '')).filter(Boolean));
  const spec = await readSpec();
  const todo = cands.filter(x => !done.has(x.slug || slugify(x.name))).slice(0, lim);
  const results = [];
  for (const x of todo) {
    if (signal?.aborted) break;
    const slug = SLUG_RE.test(x.slug || '') ? x.slug : slugify(x.name);
    let menu = '', menuUrl = '';
    // PREFER the persona's cached menu — the places/evaluations split exists precisely so verdicts
    // can be re-derived from cached menus without re-fetching (reliable for re-scans / new people).
    let placeRec = null; try { placeRec = JSON.parse((await ssh(`cat ${EAT}/places/${slug}.json 2>/dev/null`, 15000)).stdout.trim() || 'null'); } catch { placeRec = null; }
    if (placeRec && placeRec.cached_menu) { menu = String(placeRec.cached_menu); menuUrl = placeRec.menu_url || ''; onStep({ kind: 'tool', name: 'cachedMenu', detail: x.name }); }
    else {
      onStep({ kind: 'tool', name: 'menuLookup', detail: x.name });
      try {
        const sr = tools.webSearch ? await tools.webSearch(`${x.name} ${x.address || c} menu`) : null;
        const urls = (sr && sr.ok && Array.isArray(sr.results) ? sr.results : []).slice(0, 3).map(h => h.url).filter(Boolean);
        for (const u of urls) {
          let text = '';
          try { const p = tools.browse ? await tools.browse(u) : null; text = p && (p.text || p.summary || p.content || ''); } catch { /* try plain fetch */ }
          if (!text) { try { const p = tools.fetchUrl ? await tools.fetchUrl(u) : null; text = p && (p.text || p.summary || p.content || ''); } catch { /* skip */ } }
          if (text) { menu += `\n\n[${u}]\n${String(text).slice(0, 3500)}`; if (!menuUrl) menuUrl = u; }
          if (menu.length > 4500) break;
        }
      } catch { /* menu unreachable → UNKNOWN (the safe verdict) */ }
    }
    onStep({ kind: 'tool', name: 'judge', detail: x.name });
    const prompt = `Restaurant: ${x.name}\nAddress: ${x.address || ''}\nGoogle type: ${x.primary_type || ''}\n\nMENU (gathered):${menu || ' (none found)'}`;
    let verdictObj = null;
    if (menu) { const a = await opusComplete({ system: EVAL_SYS(spec), prompt, maxTokens: 900, signal }); if (a) verdictObj = parseVerdict(a); }
    if (!verdictObj && menu && tools.localModel) { const a = await tools.localModel(EVAL_SYS(spec), prompt); if (a) verdictObj = parseVerdict(a); } // fallback
    if (!verdictObj) verdictObj = { verdict: 'UNKNOWN', cuisine: x.primary_type || '', summary: menu ? 'Could not produce a confident verdict from the menu.' : 'No usable menu found.', promising_dishes: [], avoid_outright: [], kitchen_flexibility: 'N/A' };
    const today = new Date().toISOString().slice(0, 10);
    // place metadata (reusable across people) + cached menu
    await writeJson(`eating-out/places/${slug}.json`, { name: x.name, address: x.address || '', place_id: x.place_id || '', lat: x.lat, lng: x.lng, cuisine: verdictObj.cuisine || x.primary_type || '', menu_url: menuUrl, primary_type: x.primary_type || '', city: x.city || c, cached_menu: menu.slice(0, 8000), cached_menu_date: today });
    // Alexa's verdict (what the guides read)
    await writeJson(`eating-out/evaluations/alexa/${slug}.json`, { name: x.name, place_id: x.place_id || '', verdict: verdictObj.verdict, evaluated_for: 'Alexa (MCAS+histamine+fructan)', evaluated_date: today, summary: String(verdictObj.summary || '').slice(0, 600), promising_dishes: Array.isArray(verdictObj.promising_dishes) ? verdictObj.promising_dishes.slice(0, 8) : [], avoid_outright: Array.isArray(verdictObj.avoid_outright) ? verdictObj.avoid_outright.slice(0, 12) : [], kitchen_flexibility: String(verdictObj.kitchen_flexibility || '').slice(0, 300) });
    results.push({ name: x.name, slug, verdict: verdictObj.verdict, summary: verdictObj.summary });
    onStep({ kind: 'tool', name: `verdict:${verdictObj.verdict}`, detail: x.name });
  }
  const tally = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
  const remaining = Math.max(0, cands.filter(x => !done.has(x.slug || slugify(x.name))).length - results.length);
  return harden({ ok: true, city: c, evaluated: results.length, remaining, tally, results, note: remaining ? `${remaining} more candidate(s) un-evaluated — call dietEvaluateArea("${c}") again to continue.` : 'All scanned candidates for this city are evaluated.' });
};

// ── 3) BUILD MAP — rebuild safe-eats.kml (Google Maps import) from the evaluated DB.
export const buildMap = async () => {
  const r = await ssh(`cd ${EAT} && python3 build_kml.py 2>&1 && ls -la safe-eats.kml`, 60000);
  return harden({ ok: r.ok, output: r.stdout.slice(-400), error: r.ok ? '' : r.stderr.slice(0, 300) });
};

// ── 4) SITES — regenerate the guide HTML from the DB (LOCAL to the persona; not published),
//    report what changed, and (only at commit) git-push → archua-deploy publishes.
const siteKnown = site => Object.prototype.hasOwnProperty.call(SITES, String(site || ''));
export const regenSite = async (site) => {
  if (!siteKnown(site)) return harden({ ok: false, error: `unknown site "${site}". Known: ${Object.keys(SITES).join(', ')}` });
  const dir = SITES[site].dir;
  const r = await ssh(`cd ${dir} && python3 gen_guide.py 2>&1; echo "---STATUS---"; git status --porcelain 2>/dev/null`, 90000);
  const [out, statusBlock = ''] = r.stdout.split('---STATUS---');
  const changed = statusBlock.trim().split('\n').map(s => s.trim()).filter(Boolean);
  return harden({ ok: r.ok, site, regenOutput: out.trim().slice(-400), changedFiles: changed, willPublish: changed.length > 0 });
};
// the COMMIT of a site-update proposal: commit + push (archua-deploy ships it). Outward-facing.
export const publishSite = async (site, message) => {
  if (!siteKnown(site)) return harden({ ok: false, error: `unknown site "${site}"` });
  const dir = SITES[site].dir;
  const msg = String(message || 'refresh guide').replace(/["`$\\]/g, '').slice(0, 100) || 'refresh guide';
  const r = await ssh(`cd ${dir} && python3 gen_guide.py >/dev/null 2>&1; git add -A && git commit -m "${msg}" 2>&1 && git push 2>&1`, 120000);
  return harden({ ok: r.ok, site, output: (r.stdout + r.stderr).slice(-500), note: r.ok ? 'Pushed — archua-deploy will build + serve the update.' : 'push failed' });
};

// ── STATUS — verdict counts + each site's pending changes (read-only).
export const status = async () => {
  const py = [
    'import json,glob,os,collections',
    "EAT=os.path.expanduser('~/eating-out')",
    'ev=collections.Counter()',
    "for f in glob.glob(EAT+'/evaluations/alexa/*.json'):",
    '    try: d=json.load(open(f))',
    '    except Exception: continue',
    "    ev[d.get('verdict','?')]+=1",
    "print(json.dumps({'verdicts':dict(ev),'total_evaluated':sum(ev.values())}))",
  ].join('\n');
  const r = await runPy(py, 30000);
  let counts = {}; try { counts = JSON.parse(r.stdout.trim() || '{}'); } catch { counts = {}; }
  const sites = {};
  for (const [name, s] of Object.entries(SITES)) {
    const g = await ssh(`cd ${s.dir} && git status --porcelain 2>/dev/null | wc -l`, 15000);
    sites[name] = { title: s.title, pendingChanges: Number(g.stdout.trim()) || 0 };
  }
  return harden({ ok: true, ...counts, sites });
};
harden(scanArea); harden(evaluateArea); harden(buildMap); harden(regenSite); harden(publishSite); harden(status);
