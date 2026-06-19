// harvest.mjs — Task 2 / roadmap §6b. Scan the REAL chat store + the vault capture inbox,
// novelty-filter each user prompt against the existing suite, anonymize fail-closed, and emit
// PROPOSED eval candidates under eval/candidates/ (NEVER into obstacles/ — proposed, reviewed,
// not live). The suite grows from what we were actually asked to do, anonymized.
//
//   node harvest.mjs            # scan + emit proposed candidates + print a summary
//   node harvest.mjs --dry      # scan + report, emit nothing
//
// gemma (tinix:8003) is used ONLY to generalize prompts that carry personal data; when it is
// unreachable, those drop fail-closed (see anonymize.mjs). Secrets always drop deterministically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { anonymize, findSecret } from './anonymize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CHATS_DIR = `${HOME}/.local/state/voice-agent/chats`;
const INBOX_DIR = `${HOME}/obsidian/vault/inbox`;
const OBS_DIR = path.join(HERE, 'obstacles');
const OUT_DIR = path.join(HERE, 'candidates');
const dry = process.argv.includes('--dry');

const sha8 = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── gemma generalizer (optional): returns null-capable; anonymize drops PII when null ──
const probeGemma = async () => {
  try {
    const r = await fetch('http://tinix:8003/v1/models', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j0 = await r.json();
    const modelId = j0?.data?.[0]?.id || 'default'; // vllm serves it under whatever id it was loaded with
    return async prompt => {
      const body = { model: modelId, messages: [
        { role: 'system', content: 'Rewrite the user prompt into a GENERIC, reusable benchmark task. Remove ALL personal data: names, people, places, employers, identifiers. Keep the technical/intent shape. Reply with ONLY the rewritten prompt.' },
        { role: 'user', content: prompt },
      ], temperature: 0.2, max_tokens: 200 };
      const resp = await fetch('http://tinix:8003/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const j = await resp.json();
      return j.choices?.[0]?.message?.content || '';
    };
  } catch { return null; }
};

// ── suite coverage: themes + keywords already represented, for the novelty filter ──
const suiteKeywords = () => {
  const kw = new Set();
  for (const d of fs.existsSync(OBS_DIR) ? fs.readdirSync(OBS_DIR) : []) {
    const g = path.join(OBS_DIR, d, 'grade.mjs');
    if (!fs.existsSync(g)) continue;
    const src = fs.readFileSync(g, 'utf8');
    for (const w of (src.match(/theme:\s*'([^']+)'/g) || [])) kw.add(w.replace(/.*'([^']+)'.*/, '$1'));
    // crude: the attenuation obstacle covers share/revoke/attenuat/read-only
    for (const t of ['attenuat', 'revoke', 'read-only facet']) if (src.includes(t)) kw.add(t);
  }
  return kw;
};

// ── collect candidate user prompts from the real store + inbox ──
const collectPrompts = () => {
  const out = [];
  // latest chat-store snapshot
  const files = fs.existsSync(CHATS_DIR) ? fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(CHATS_DIR, f)) : [];
  if (files.length) {
    const latest = files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
    const store = JSON.parse(fs.readFileSync(latest, 'utf8'));
    for (const [chatId, turns] of Object.entries(store.tx || {})) {
      for (const t of turns) if (t && t.who === 'you' && t.text) out.push({ src: `chat:${sha8(chatId)}`, text: String(t.text) });
    }
  }
  // vault capture inbox (.md files; the immutable arrivals)
  if (fs.existsSync(INBOX_DIR)) {
    for (const f of fs.readdirSync(INBOX_DIR)) {
      const p = path.join(INBOX_DIR, f);
      if (f.endsWith('.md') && fs.statSync(p).isFile()) out.push({ src: `inbox:${f}`, text: fs.readFileSync(p, 'utf8') });
    }
  }
  return out;
};

const main = async () => {
  const gemma = await probeGemma();
  const kw = suiteKeywords();
  const prompts = collectPrompts();
  const seen = new Set();
  const emitted = [];
  const dropped = [];
  let coveredSkips = 0, dupSkips = 0;

  for (const { src, text } of prompts) {
    const n = norm(text);
    if (n.length < 12) { continue; }                              // too short to be a task
    if (seen.has(n)) { dupSkips += 1; continue; }                 // novelty: dedupe
    seen.add(n);
    if ([...kw].some(k => n.includes(k))) { coveredSkips += 1; continue; } // novelty: already in suite

    const a = await anonymize(text, { gemma });
    if (!a.ok) { dropped.push({ src, reason: a.reason }); continue; }
    emitted.push({
      id: sha8(src + n), src, ask: a.text, theme: 'harvested',
      provenance: 'prompt-harvest', proposed: true,
      anonymization: { secretScrub: 'pass', pii: a.axes.pii || [], method: a.reason, gemma: !!gemma },
    });
  }

  // FAIL-CLOSED ASSERT: zero secret-shaped content in anything we are about to emit.
  for (const c of emitted) {
    const hit = findSecret(JSON.stringify(c));
    if (hit) { console.error(`FATAL: secret (${hit}) survived into candidate ${c.id} — refusing to emit ANY.`); process.exit(3); }
  }

  console.log(`harvest: ${prompts.length} prompts · ${seen.size} unique · gemma=${gemma ? 'up' : 'DOWN'}`);
  console.log(`  novelty: ${dupSkips} dup-skipped, ${coveredSkips} already-covered-skipped`);
  console.log(`  emitted: ${emitted.length} candidate(s)`);
  console.log(`  dropped (fail-closed): ${dropped.length}`);
  for (const d of dropped) console.log(`    ✗ ${d.src}  — ${d.reason}`);

  // Candidates are written LOCAL-ONLY (proposed, for human review) and are NOT published:
  // they derive from real conversations, so even secret-clean they stay off any shared repo
  // until gemma-generalized + reviewed. eval/candidates/ is gitignored. The PR ships the
  // tooling + tests + this SCRUBBED summary (counts + drop reasons only — no raw asks).
  if (!dry && emitted.length) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, '.gitignore'), '*.json\n'); // proposals are local-only
    fs.writeFileSync(path.join(OUT_DIR, 'README.md'),
      `# eval/candidates/ — PROPOSED, LOCAL-ONLY\n\nMachine-harvested + anonymized eval candidates (Task 2 / roadmap §6b).\n**Proposals only** — NEVER auto-added to \`obstacles/\` (a human promotes one by hand-authoring a\n\`grade.mjs\`) and **NEVER published** (the \`*.json\` here are gitignored). Every candidate passed the\nfail-closed secret scrub; PII candidates were gemma-generalized or dropped. Source = a chat-id HASH.\n`);
    for (const c of emitted) fs.writeFileSync(path.join(OUT_DIR, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
    console.log(`  wrote ${emitted.length} (LOCAL-ONLY, gitignored) → ${path.relative(process.cwd(), OUT_DIR)}/`);
  }

  // scrubbed, publishable summary (no raw asks)
  if (!dry) {
    const summary = {
      ranAt: new Date().toISOString(), promptsScanned: prompts.length, unique: seen.size,
      gemmaUp: !!gemma, emitted: emitted.length, dropped: dropped.length,
      dropReasons: dropped.reduce((m, d) => { const k = d.reason.split(':')[0]; m[k] = (m[k] || 0) + 1; return m; }, {}),
      secretLeaks: 0, // asserted above — process exits non-zero before here if any survived
      note: 'Candidates are local-only + gitignored (derive from real chats). This summary carries NO raw prompt text.',
    };
    fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
    fs.writeFileSync(path.join(HERE, 'results', 'harvest-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`  summary → eval/results/harvest-summary.json (publishable; no raw text)`);
  }
};
main();
