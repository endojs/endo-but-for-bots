// dietician-js.mjs — the dietician power, CUT OVER from SSH-driving the agent-dietician persona to the
// in-process JS port (packages/chat/dietician-app). All COMPUTE — scan (with on-the-fly geocoding of a NEW
// city), evaluate (cached-menu preferred, else the field agent's web caps), buildMap, status — runs in JS over
// dan's imported instance store (parity with the persona DB). PUBLISHING the two LIVE public guides still
// rides the existing deploy lane: dietRefreshSite generates the guide HTML in JS, then (only on confirm) writes
// it to the persona's git-deploy repos + pushes, so eats-guide.chu / disneyland-food-guide.chu keep working —
// now JS-powered. The old SSH bridge (dietician.mjs) stays as a fallback. Exports mirror dietician.mjs so the
// power verbs are unchanged. (Google Places + Anthropic keys are read from the secret registry by the
// providers, server-side, never reaching the agent.)
import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { HOME, VAULT_DIR, personalAt, DIETICIAN_HOST } from './field-config.mjs';
import { makeFsFolder } from '../dietician-app/fs-folder.mjs';
import { makeDietStore } from '../dietician-app/store.mjs';
import { makePipeline } from '../dietician-app/core.mjs';
import * as places from '../dietician-app/providers/places.mjs';
import { makeJudge } from '../dietician-app/providers/judge.mjs';
import { makeAnthropicComplete } from '../dietician-app/providers/anthropic.mjs';
import { SEED_CITIES } from '../dietician-app/cities.mjs';

const PERSON = process.env.DIET_PERSON || 'alexa';
// The dietician-app state lives in its OWN ~/.local/state/dietician-app namespace (not field-agent's),
// so there is no direct field-config export; rebase it with personalAt the same way field-config does
// (byte-identical default on the NUC; moves onto FIELD_PERSONAL_ROOT with the rest of the personal family).
const INSTANCE_ROOT = process.env.DIET_ROOT_DIR || `${personalAt('state/dietician-app', `${HOME}/.local/state/dietician-app`)}/instances/${PERSON}`;
const HOST = DIETICIAN_HOST; // dietician persona — used ONLY for the publish step (write HTML → git push); from field-config ENDPOINTS (env: DIETICIAN_HOST)

const store = makeDietStore(makeFsFolder(INSTANCE_ROOT), { person: PERSON });
const judge = makeJudge({ complete: makeAnthropicComplete() });

// The family edits its diet rules in the Obsidian vault (Dietician/<Person> — Diet.md); make THAT the single
// source of truth for evaluation. specStore overrides readSpec to read the vault note (frontmatter + blockquote
// header stripped), falling back to the instance diet.md. So a change like "more gluten in Europe" takes effect
// immediately, with no separate spec-edit verb.
const VAULT = VAULT_DIR; // field-config: honors OBSIDIAN_VAULT, else rebases onto FIELD_PERSONAL_ROOT
const PERSON_NAME = PERSON.charAt(0).toUpperCase() + PERSON.slice(1);
const readVaultSpec = () => {
  try { return fs.readFileSync(`${VAULT}/Dietician/${PERSON_NAME} — Diet.md`, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim().replace(/^(> .*(\n|$))+/, '').trim(); }
  catch { return ''; }
};
const specStore = { ...store, readSpec: async () => readVaultSpec() || (await store.readSpec()) };
const basePipe = makePipeline({ store: specStore, places, judge, person: PERSON }); // scan/buildMap/generate/status

const slugify = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// the two published guides → { which guide, the persona git-deploy repo dir }
const SITES = {
  'eats-guide': { which: 'eats', dir: '~/eats-guide', title: 'Eats Guide' },
  'disneyland-food-guide': { which: 'disney', dir: '~/disneyland-food-guide', title: 'Disneyland Food Guide' },
};
export const DIET_SITES = harden(Object.keys(SITES));

const ssh = (cmd, timeoutMs = 120000) => new Promise(resolve =>
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, '--', cmd],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    (err, so, se) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(so || ''), stderr: String(se || '').slice(0, 4000) })));
const b64 = s => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const sshWrite = (remotePath, content) => ssh(`mkdir -p "$(dirname ${remotePath})" && echo ${b64(content)} | base64 -d > ${remotePath}`, 30000);

// ── SCAN — a known city, OR a NEW place geocoded on the fly: a city, OR a hotel/landmark to sweep a few
// miles around. `radiusMiles` (default ~5 mi ≈ whole-city) + `cap` (default 80) control the coverage. ──
export const scanArea = async (city, opts = {}) => {
  const c = slugify(city);
  if (!c) return harden({ ok: false, error: 'a city is required (e.g. "oakland", "berlin", or a hotel name)' });
  if (SEED_CITIES[c]) return harden(await basePipe.scan(c)); // a configured city/park → its tuned sweep
  const miles = Number(opts.radiusMiles) > 0 ? Math.min(15, Number(opts.radiusMiles)) : 5; // ~whole-city by default
  const cap = Number(opts.cap) > 0 ? Math.max(1, Math.min(120, Math.round(Number(opts.cap)))) : 80;
  const g = await places.geocode(city);
  if (!g.ok) return harden({ ok: false, error: `"${city}" isn't a configured city and I couldn't geocode it — ${g.error}` });
  const r = await basePipe.scan({ slug: c, name: g.name, center: { latitude: g.lat, longitude: g.lng }, radius: Math.round(miles * 1609), cap });
  return harden({ ...r, geocoded: { name: g.name, lat: g.lat, lng: g.lng, miles, cap },
    note: `Auto-geocoded "${g.name}" — swept ~${miles} mi around it, up to ${cap} candidates. ${r.note || ''}` });
};

// ── EVALUATE — cached_menu preferred; else the field agent's web caps (passed in as `tools`). Each verdict
// is written as produced (idempotent), so a big batch cut short by the turn limit still saves its progress. ──
export const evaluateArea = async ({ city, limit = 10, tools = {}, onStep = () => {}, signal } = {}) => {
  const pipe = makePipeline({ store: specStore, places, judge, web: tools, person: PERSON });
  return harden(await pipe.evaluate({ city: slugify(city), limit, onStep, signal }));
};

// ── BUILD MAP — rebuild safe-eats.kml from the evaluated DB ──
export const buildMap = async () => {
  const r = await basePipe.buildMap();
  return harden({ ok: r.ok, total: r.total, viable: r.viable, borderline: r.borderline,
    output: `safe-eats.kml rebuilt — ${r.viable} VIABLE + ${r.borderline} BORDERLINE (${r.bytes} bytes).`, error: r.ok ? '' : 'build failed' });
};

// ── STATUS — verdict counts + the published guides (read-only) ──
export const status = async () => {
  const counts = await store.counts();
  const sites = {};
  for (const [name, s] of Object.entries(SITES)) sites[name] = { title: s.title, which: s.which };
  return harden({ ok: true, verdicts: { VIABLE: counts.VIABLE, BORDERLINE: counts.BORDERLINE, SKIP: counts.SKIP, UNKNOWN: counts.UNKNOWN },
    total_evaluated: counts.total, sites, source: 'dietician-app (in-process JS port)' });
};

// ── REGEN (propose) — generate the guide HTML in JS + report what would publish ──
export const regenSite = async site => {
  const cfg = SITES[site];
  if (!cfg) return harden({ ok: false, error: `unknown site "${site}". Known: ${Object.keys(SITES).join(', ')}` });
  const r = await basePipe.generateGuide(cfg.which);
  if (!r.ok) return harden({ ok: false, error: r.error || 'generate failed' });
  return harden({ ok: true, site, changedFiles: ['site/index.html', 'site/sort.js'], willPublish: true,
    regenOutput: `${cfg.title}: ${r.cards} cards (${r.viable} VIABLE + ${r.borderline} BORDERLINE${r.hotel != null ? `, +${r.hotel} near the hotel` : ''}).` });
};

// ── PUBLISH (commit) — write the JS-generated HTML into the persona's git-deploy repo + push ──
export const publishSite = async (site, message) => {
  const cfg = SITES[site];
  if (!cfg) return harden({ ok: false, error: `unknown site "${site}"` });
  await basePipe.generateGuide(cfg.which); // ensure fresh artifacts in the instance store
  const html = await store.readArtifact(`site/${cfg.which}/index.html`);
  const js = await store.readArtifact(`site/${cfg.which}/sort.js`);
  if (!html) return harden({ ok: false, error: 'no generated guide to publish — regen first' });
  const w = await sshWrite(`${cfg.dir}/site/index.html`, html);
  if (!w.ok) return harden({ ok: false, error: `could not write to the deploy repo: ${(w.stderr || '').slice(0, 200)}` });
  if (js) await sshWrite(`${cfg.dir}/site/sort.js`, js);
  const msg = String(message || `refresh ${site}`).replace(/["`$\\]/g, '').slice(0, 100) || `refresh ${site}`;
  const r = await ssh(`cd ${cfg.dir} && git add -A && (git diff --cached --quiet && echo "no changes" || (git commit -m "${msg}" && git push)) 2>&1`, 120000);
  return harden({ ok: r.ok, site, output: (r.stdout + r.stderr).slice(-500), note: r.ok ? 'Published — archua-deploy will build + serve the JS-generated guide.' : 'publish failed' });
};

harden(scanArea); harden(evaluateArea); harden(buildMap); harden(status); harden(regenSite); harden(publishSite);
