// server.mjs — the field agent as an Endo-permissioned host service (Recipe A,
// ENDO-PUBLISHING.md). The agent's authority is a bundle of object capabilities
// reached ONLY through a swissnum in the #cap= URL fragment. Binding the bare
// URL grants NOTHING; the root link grants the full bundle; a share() link
// grants exactly one power. Voice chat runs the cap-confined tool agent over
// whatever bundle the presented cap resolves to.
//
//   browser mic ─VAD→ /stt (whisper) ─→ /chat {cap} ─→ runAgent(toolboxFor(cap))
//   Shares panel ─→ /rpc {swissnum, method} ─→ node.cap[method]  (describe/share/…)
//
// SES process: caps run under @endo/init. Tailnet + loopback bind only.
import '@endo/init';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E } from '@endo/eventual-send';
import { makeFieldAgent, ALL_POWERS, POWERS, HOME_BASE } from './agent-caps.mjs';
import { runAgent, buildUserContent, callLLM } from '../../ocapn-noise/tool-bridge.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';
// CodeMode (default ON): the agent acts by writing ONE composable JS program per turn, run in a
// SES Compartment endowed with exactly its caps (lexical confinement), instead of one TOOL_CALL
// per turn. Set AGENT_CODEMODE=0 to fall back to the classic loop. See codemode.mjs.
const AGENT_RUNNER = process.env.AGENT_CODEMODE === '0' ? runAgent : runAgentCode;
import { readAsks, getAsk, answerAsk, setAskStatus, formatAnswers, getSecret, storeNamedSecret } from './asks-store.mjs';
import { makeConnectors } from './connectors.mjs';
import { makeCustomTools } from './custom-tools.mjs';
import { makeToolShares } from './tool-shares.mjs';
import { makeComponentGit } from './component-git.mjs';
import { makeIslandSource } from './island-source.mjs';
import { STARTER_RING } from './system-map.mjs';
const connectors = makeConnectors({ getSecret }); // owner-side registry (same connectors.json the agent calls)
const customTools = makeCustomTools(); // owner-side review/admit (same custom-tools.json the agent reads)
import { makeAppStore } from './app-state.mjs';
import { makePurse } from './purse.mjs';
import { makePurseStore } from './purse-store.mjs';
import { makeMeteredLLM } from './meter.mjs';
import { loadStripeCfg, stripeConfigured, recordPending, checkoutForm, verifyWebhook, settleEvent } from './pay.mjs';
import { gatorConfigured, recordDelegation, redeemDelegation } from './delegation-pay.mjs';
import { budgetLine, costOf } from './costModel.mjs';
import { makeTollBridge } from './toll-bridge.mjs';
import * as projects from './projects.mjs';
import { makeMeetingScribe } from './meeting-scribe.mjs';
import { opusComplete } from './delegate.mjs';
import { runReviewPanel } from './review-panel.mjs';
import { notify } from '../capture/notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = '/home/dan';
const PORT = Number(process.env.PORT) || 8778;
const BIND = (process.env.BIND ? process.env.BIND.split(',').map(s => s.trim()).filter(Boolean) : ['100.83.80.102', '127.0.0.1']); // tailnet IP + loopback — never 0.0.0.0 (overridable for staging)
// Public-facing base for cap URLs. The browser mic (getUserMedia) requires a
// SECURE CONTEXT, so the app is fronted by `tailscale serve` HTTPS on the tailnet
// (https://archua.taildd002.ts.net) — NOT public. Cap links must use that origin.
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://100.83.80.102:${PORT}`;
const WHISPER = process.env.STT_URL || 'http://192.168.50.226:8000/v1/audio/transcriptions';
const STT_MODEL = process.env.STT_MODEL || 'deepdml/faster-whisper-large-v3-turbo-ct2';
const OUT = process.env.OUT_DIR || `${HOME}/.local/state/voice-agent/out`;
const toolShares = makeToolShares({ dir: `${HOME}/.local/state/voice-agent/tool-shares` }); // share-as-factory/instance + meter + charge
const componentGit = makeComponentGit({ baseDir: `${HOME}/.local/state/voice-agent/component-git` }); // each component's SOURCE as a git-as-Endo object (version / fork / revert)
const islandSource = makeIslandSource({ here: HERE, componentGit }); // confined-Preact ISLANDS as versioned components (edit = rewrite client file + rebuild)
// A tool's source as a {relpath: content} file map for the component-git store (single-file → tool.js).
const sourceFilesOf = t => (t.files && typeof t.files === 'object' && Object.keys(t.files).length ? t.files : { 'tool.js': String(t.code || '') });
// Propose a tool FROM a {path:content} files map — single-file ({tool.js}) → code; else a multi-file class.
const proposeFromFiles = (ct, { name, description, files, proposedBy }) => {
  const keys = Object.keys(files || {});
  if (keys.length === 1 && keys[0] === 'tool.js') return ct.propose({ name, description, code: files['tool.js'], kind: 'instance', proposedBy, now: new Date().toISOString() });
  return ct.propose({ name, description, files, entry: 'tool.js', kind: 'class', proposedBy, now: new Date().toISOString() });
};
// PER-COMPONENT EDIT AGENT (Phase 3): a confined agent that sees ONLY one component's source + the
// edit request, and returns the complete updated source. The change is committed as a new version
// (revertable) and applied live. Single-file components (the common case) for now.
const EDIT_SYS = 'You are a focused engineer editing ONE confined library component. Its source is the BODY of `make(powers)` (Endo unconfined-guest convention) returning a STATEFUL object whose methods close over private state. `powers` gives ONLY: `state` (durable kv: get/set/delete/all), `grains` (durable mergeable cells: `powers.grains.cell(name,{merge}).read()/addContent(v)/subscribe(fn)`; merges lastWriteWins|max|min|sum|append|union — the component DATA, which survives source edits), and `console`. It is SES-confined: NO fs, network, import, or ambient globals. Apply the user\'s requested change faithfully, keep it working, and keep using powers.state/grains for persistence. Reply with ONLY the complete updated make-body as a single ```js fenced code block — no prose, no commentary.';
const extractJs = s => { const m = /```(?:js|javascript)?\s*\n([\s\S]*?)```/i.exec(String(s || '')); return m ? m[1].trim() : String(s || '').trim(); };
const editComponentSource = async (ct, id, prompt) => {
  const t = ct.get(id); if (!t) return { ok: false, error: 'no such component' };
  if (!String(prompt || '').trim()) return { ok: false, error: 'describe the change you want' };
  const snap = await componentGit.readAt(id, 'HEAD'); const files = (snap && snap.files) || sourceFilesOf(t);
  const keys = Object.keys(files);
  if (!(keys.length === 1 && keys[0] === 'tool.js')) return { ok: false, error: 'the edit agent handles single-file components for now — edit a multi-file class in chat' };
  let out = '';
  // NB: opusComplete returns the completion STRING (or null), not an object.
  try { out = String((await opusComplete({ system: EDIT_SYS, prompt: `Current source:\n\`\`\`js\n${files['tool.js']}\n\`\`\`\n\nRequested change: ${String(prompt)}`, maxTokens: 4000 })) || ''); }
  catch (e) { return { ok: false, error: `edit agent failed: ${(e && e.message) || e}` }; }
  if (!out.trim()) return { ok: false, error: 'the edit agent returned nothing (model unavailable?)' };
  const code = extractJs(out); if (!code) return { ok: false, error: 'the edit agent returned no code' };
  const newFiles = { 'tool.js': code };
  let review = null; try { review = await runReviewPanel({ name: t.name, description: t.description, code, kind: t.kind }, { callLLM, ranAt: new Date().toISOString() }); } catch { /* advisory */ }
  const rec = await componentGit.commit(id, newFiles, `edit: ${String(prompt).slice(0, 60)}`);
  ct.setSource(id, newFiles); // apply live (the owner triggered it; revert from the Studio if unwanted)
  return { ok: true, version: rec.version, review, note: 'Edited — committed as a new version + applied to the live component. Revert from the Components tab if you don\'t like it.' };
};

// Editing a confined-Preact ISLAND (its source is a client file → rewrite + rebuild, not make(powers)).
const ISLAND_EDIT_SYS = 'You are editing a confined-Preact ISLAND — a UI component rendered through @endo/preact-container `renderConfined`. The source is a JS module built with `h(tag, props, children)` hyperscript (NO JSX), pure + stateless (state lives in cells passed via props; render-safe data only — never a swissnum/secret). Apply the user\'s requested change, keep it valid h-based confined Preact, keep the SAME exports and imports (add none), and use no DOM/network/fs/ambient access. Reply with ONLY the complete updated file as a single ```js fenced code block — no prose.';
const editIslandSource = async (id, prompt) => {
  if (!String(prompt || '').trim()) return { ok: false, error: 'describe the change you want' };
  const cur = await islandSource.readSourceText(id, 'HEAD'); if (cur === null) return { ok: false, error: 'unknown island' };
  let out = '';
  try { out = String((await opusComplete({ system: ISLAND_EDIT_SYS, prompt: `Current source (${islandSource.fileOf(id)}):\n\`\`\`js\n${cur}\n\`\`\`\n\nRequested change: ${String(prompt)}`, maxTokens: 4000 })) || ''); }
  catch (e) { return { ok: false, error: `edit agent failed: ${(e && e.message) || e}` }; }
  const code = extractJs(out); if (!code.trim()) return { ok: false, error: 'the edit agent returned nothing (model unavailable?)' };
  return islandSource.applySource(id, code, `edit: ${String(prompt).slice(0, 60)}`);
};

// Fork a component into a NEW pending tool: clone its git source lineage at `ref` + COPY its grain data.
const forkComponentTo = async (ct, srcId, newName, ref = 'HEAD', proposedBy = 'owner') => {
  const src = ct.get(srcId); if (!src) return { ok: false, error: 'no such component' };
  if (!String(newName || '').trim()) return { ok: false, error: 'name the fork' };
  const snap = await componentGit.readAt(srcId, ref); const files = (snap && snap.files) || sourceFilesOf(src);
  const p = proposeFromFiles(ct, { name: newName, description: `[fork of ${src.name}] ${src.description || ''}`, files, proposedBy });
  if (!p.ok) return p;
  try { await componentGit.fork(srcId, p.id, ref); } catch { try { await componentGit.commit(p.id, files, `fork of ${src.name}`); } catch (e) { log('fork commit', e.message); } }
  ct.copyGrains(srcId, p.id); // the fork starts from the source's DATA
  return { ok: true, forkId: p.id, name: newName, note: 'Forked — its own source lineage + a copy of the data. It enters review; admit it to host your fork. The original is untouched.' };
};
const UPLOADS = `${OUT}/uploads`; // user-attached photos/files (served under web-key'd /uploads/<hex>.<ext>)
const SEED_FILE = process.env.SEED_FILE || `${HOME}/.config/field-agent/root.swiss`;
const CHATS_DIR = `${HOME}/.local/state/voice-agent/chats`; // per-cap chat list + transcripts (cross-device sync)
const chatStorePath = cap => path.join(CHATS_DIR, crypto.createHash('sha256').update(String(cap || '')).digest('hex').slice(0, 40) + '.json');
// notification inbox (the 🔔 bell): the dashboard's durable feed is the shared data
// endowment; per-cap dismissed-state lives here. An entry "needs attention" by its status.
const FEED_FILE = `${HOME}/.local/state/field-dashboard/feed.json`;
const NOTIF_DIR = `${HOME}/.local/state/voice-agent/notif-triage`;
const notifStorePath = cap => path.join(NOTIF_DIR, crypto.createHash('sha256').update(String(cap || '')).digest('hex').slice(0, 40) + '.json');
// review/confirm/decision are the operator-action notification kinds ("needs review",
// "needs confirming", "needs your decision"); enumerate them by kind so a status that
// drops the leading "needs" (e.g. "please confirm", "review requested") still flags.
const ATTENTION_RE = /needs|attention|flag|operator|review|confirm|decision|blocker|unsynced|error|degraded|⚡|🔔/i;
// ── feed-link → clickable href ───────────────────────────────────────────────
// Feed entries carry links as { label, url }. The url is one of: a web URL, a
// vault-relative note path (`the field/TADA/x.md`, `~/TADA/x`, `TODO/x.md`), or a
// non-navigable ref (`automerge:…`). Mirror the dashboard's resolver so the 🔔 bell
// and the dashboard agree: vault paths → obsidian://open deep links (realpath
// follows the ~/TADA → "the field/TADA" symlink); web URLs pass through; anything
// else gets an empty href and renders as plain text.
const VAULT_DIR = path.join(HOME, 'obsidian/vault');
const VAULT_NAME = 'Obsidian'; // the Obsidian app's vault name (not the dir basename)
const VAULT_REAL = (() => { try { return fs.realpathSync(VAULT_DIR); } catch { return VAULT_DIR; } })();
const encodeObsidian = s => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
const obsidianLink = relPathNoExt => `obsidian://open?vault=${encodeObsidian(VAULT_NAME)}&file=${encodeObsidian(relPathNoExt)}`;
const resolveVaultPath = p => {
  if (!p || typeof p !== 'string' || /^[a-z]+:\/\//i.test(p)) return null; // external URL / scheme
  let raw = p.trim();
  if (raw.startsWith('~/')) raw = path.join(HOME, raw.slice(2));
  const base = path.isAbsolute(raw) ? raw : path.join(VAULT_DIR, raw);
  const candidates = base.endsWith('.md') ? [base] : [`${base}.md`, base];
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      const rel = path.relative(VAULT_REAL, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\.md$/, '');
    } catch { /* not found — try next */ }
  }
  return null;
};
// Normalize a stored link (object {label,url} or bare string) → { label, url, href }
// where href is a safe, navigable target ('' = not linkable, render as text).
const feedLinkHref = l => {
  const url = (l && (l.url || l.href)) || (typeof l === 'string' ? l : '');
  const label = (l && l.label) || url;
  const rel = resolveVaultPath(url);
  const href = rel ? obsidianLink(rel)
    : /^(https?|obsidian|mailto):/i.test(url) ? url
    : ''; // automerge:, unresolved paths, javascript:/data: → not linkable
  return { label, url, href };
};
// memo runs: each incoming voice memo is processed by the entry agent → a traceable
// "run" (transcript + the agent's steps[]). Server-owned (not the editable per-cap chats).
const MEMO_RUNS_FILE = process.env.MEMO_RUNS_FILE || `${HOME}/.local/state/voice-agent/memo-runs.json`;
const DEV_QUEUE_FILE = `${HOME}/.local/state/field-agent/dev-queue.jsonl`; // dev-task visibility + thread replies
// a run holds VERSIONS — each {env → trace} — so re-running the same memo under a changed
// environment appends a version you can scrub through. Old flat runs normalize to v0.
const readMemoRuns = async () => {
  try {
    const runs = (JSON.parse(await fs.promises.readFile(MEMO_RUNS_FILE, 'utf8')).runs) || [];
    return runs.map(r => (r.versions ? r : { id: r.id, title: r.title, transcript: r.transcript, source: r.source, date: r.date, versions: [{ v: 0, label: 'original', env: {}, answer: r.answer || '', toolsUsed: r.toolsUsed || [], steps: r.steps || [], at: r.date }] }));
  } catch { return []; }
};
const writeMemoRuns = async runs => { await fs.promises.mkdir(path.dirname(MEMO_RUNS_FILE), { recursive: true }); await fs.promises.writeFile(MEMO_RUNS_FILE, JSON.stringify({ runs: runs.slice(0, 100) }, null, 2)); };
// seed-chats: a voice note (or any external input) ingested as a FIRST-CLASS,
// continuable chat. The client adopts these into its own chat list once (additively,
// so it never clobbers unsynced local edits), after which they are normal chats —
// continuable, cross-device-synced, 3D-traceable, and deep-linkable (#chat=<id>).
const INPUT_QUEUE = `${HOME}/.local/state/field-dashboard/input-queue.json`; // the off-app drain (input-runner polls this)
// enqueue an operator's answer for the off-app agent drain (input-runner → claude -p).
// Uses the kind:'reply' shape so the answer is passed to the worker INLINE. Atomic write.
const enqueueReply = ({ doc = '', label = '', title = '', prompt = '' }) => {
  let q; try { q = JSON.parse(fs.readFileSync(INPUT_QUEUE, 'utf8')); } catch { q = { items: [] }; }
  if (!Array.isArray(q.items)) q.items = [];
  q.items.push({ id: `rep-${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`, kind: 'reply', doc, label, title, prompt: String(prompt || '').slice(0, 4000), ts: new Date().toISOString(), status: 'pending' });
  q.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(INPUT_QUEUE), { recursive: true });
  const tmp = `${INPUT_QUEUE}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2)); fs.renameSync(tmp, INPUT_QUEUE);
};
const SEED_CHATS_FILE = `${HOME}/.local/state/voice-agent/seed-chats.json`;
const readSeedChats = async () => { try { return (JSON.parse(await fs.promises.readFile(SEED_CHATS_FILE, 'utf8')).chats) || []; } catch { return []; } };
const writeSeedChats = async chats => { await fs.promises.mkdir(path.dirname(SEED_CHATS_FILE), { recursive: true }); await fs.promises.writeFile(SEED_CHATS_FILE, JSON.stringify({ chats: chats.slice(0, 80) }, null, 2)); };

// the field agent's window onto the app's OWN stateful aspects (every conversation +
// asks/feed overview). Defined in app-state.mjs; wired here with this server's stores. The
// cap is bound + closed over per-request in /chat (it never enters the agent's ctx — cap-hygiene).
// per-cap-bundle write serializer: the chat bundle is now multi-writer (the client's /chats/save
// AND the agent's retitle). Chain writes per chatStorePath so neither clobbers the other.
const chatLocks = new Map();
const withChatLock = (cap, fn) => { const key = chatStorePath(cap); const run = (chatLocks.get(key) || Promise.resolve()).then(fn, fn); chatLocks.set(key, run.then(() => {}, () => {})); return run; };
const appStore = makeAppStore({ chatStorePath, readMemoRuns, writeMemoRuns, readSeedChats, writeSeedChats, readAsks, feedFile: FEED_FILE, withChatLock });

// ── prepaid inference toll-bridge (Increment 1): a per-conversation µUSD purse meters
//    every model call (meter.mjs). DEFAULT_ALLOWANCE seeds a new chat; /budget/{topup,set,
//    default} adjust it. IN-MEMORY for now → resets on restart; Increment 6 persists per-chat
//    balances + migrates the ledger to agora's makeBank. Keyed per (cap, chat). ──
const DEFAULT_ALLOWANCE = Number(process.env.DEFAULT_ALLOWANCE_UUSD) || 1_000_000; // µUSD ($1.00)
let defaultAllowance = DEFAULT_ALLOWANCE;
const chatPurses = new Map(); // `${cap}:${sid}` → purse
// Durable balances: a purse's mutations persist (hashed key → {balance,granted}); on boot a chat's purse
// rehydrates from disk instead of resetting to the default allowance. (Increment 6 swaps this for agora's
// journaled bank behind the same shape.)
const purseStore = makePurseStore({ file: `${HOME}/.local/state/voice-agent/purses.json` });
const purseFor = (cap, sid) => {
  const k = `${cap}:${sid}`;
  let p = chatPurses.get(k);
  if (!p) {
    const saved = purseStore.get(k); // {balance, granted} if this purse was ever persisted
    p = makePurse(saved ? saved.balance : defaultAllowance, { granted: saved ? saved.granted : undefined, onChange: (b, g) => purseStore.set(k, b, g) });
    if (!saved) purseStore.set(k, p.balance(), p.granted()); // record the initial grant so a restart before any spend still restores it
    chatPurses.set(k, p);
  }
  return p;
};
// Central toll-bridge for EDIT (AI-credit spend) + SAVE/HOST (storage×time) rights, used by the SPWA
// self-editors. Same µUSD purse ledger as inference, in a separate `toll:<account>` namespace.
const tollBridge = makeTollBridge({ purseStore, makePurse, costOf, ledgerFile: `${HOME}/.local/state/voice-agent/hosting-ledger.json` });
setInterval(() => { try { tollBridge.accrue(); } catch { /* best-effort hourly rent */ } }, 3_600_000).unref?.();
// run the entry agent on a transcript, capturing the step trace. Bounded by the ALLOWANCE METER
// (a fresh default-allowance purse per run) — there is no step limit; spend is the budget.
const traceRun = async (node, transcript, persona, chatId) => {
  const { toolbox, manifest } = node.toolbox({ chatId });
  const steps = [];
  const purse = makePurse(defaultAllowance);
  const llm = makeMeteredLLM({ callLLM, purse, perProvider: {} });
  const r = await AGENT_RUNNER({ toolbox, manifest, userText: transcript, persona, llm, budgetLine: budgetLine(purse.balance(), 'default'),
    onStep: s => { if (s.kind !== 'tool' || !s.result) return; const step = { name: s.name, ok: s.result.ok !== false }; if ((s.name === 'delegateTask' || s.name === 'askSpecialist' || s.name === 'research' || s.name === 'employ') && Array.isArray(s.result.toolsUsed)) step.children = s.result.toolsUsed.map(x => ({ name: x.name || String(x), detail: x.args ? detailFromArgs(x.args) : '', call: x.args ? safeText(x.args, 4000) : '', result: x.result !== undefined ? safeText(x.result, 4000) : '' })); steps.push(step); } });
  return { answer: r.answer || '', toolsUsed: (r.toolsUsed || []).map(x => x.name), steps };
};

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
const newSwissRe = /^[0-9a-f]{32}$/;

const { rootNode, registerRoot, nodeFor, getProposal, commitProposal, rejectProposal, buildHomeAssistant, buildAgents, buildContacts, buildKazputer, siteDir, getPersona, runScheduledAgent, mintScopedCap, rescopeCap, specialistFor } = makeFieldAgent({ outDir: OUT, baseUrl: BASE_URL });

// ── plan-then-confine (Feature A): a scoping agent proposes the MINIMAL powers a prompt needs;
// the user approves; we mint a per-chat cap holding exactly those, and the chat runs under it
// (lexically confined — no ungranted power is reachable). The catalog the scoper picks from: ──
const POWER_CATALOG = ALL_POWERS.map(p => ({ power: p, label: (POWERS[p] && POWERS[p].label) || p }));
const SCOPE_SYS = 'You are a permission scoper for an agent. Given a user TASK and a CATALOG of powers: FIRST think through the concrete steps the agent must take to COMPLETE the task end to end — INCLUDING producing, publishing, or saving its OUTPUT — then return the powers those steps need. Prefer the FEWEST that still let the task FINISH (least privilege), but NEVER omit a power the deliverable requires. If the task builds, writes, publishes, renders, deploys, or saves anything (a page, graph, diagram, dashboard, site, widget, file, note, tool, or image), INCLUDE the power that produces it — e.g. "home" to publish a page/site/graph or write files, "images" to generate an image, "editNote" to write a note, "feed" to post. A task that cannot finish for lack of a power is WORSE than one extra power. Reply with ONLY a JSON array of power-name strings drawn from the catalog (e.g. ["research","home"]). No prose.';
const scopeUser = task => `TASK:\n${task}\n\nCATALOG (name: what it does):\n${POWER_CATALOG.map(c => `${c.power}: ${c.label}`).join('\n')}\n\nReturn a JSON array of the minimal needed power names.`;
const scopePrompt = task => [{ role: 'system', content: SCOPE_SYS }, { role: 'user', content: scopeUser(task) }];
// scope a prompt → minimal powers. gemma first; if it's down/empty, fall back to our most trusted
// agent (Claude/Opus) — confinement quality shouldn't silently degrade when the local model is out.
// The scoper first does PRIVATE round-trips — confined to the fully-private read-only domain
// (notes, the library+Wikipedia, agent capability docs) — to understand the task, THEN proposes the
// endowments. This is a real agent run (it may search notes / consult Wikipedia / check agent docs)
// confined to powers that can't leak or act. Falls back to a plain gemma→claude completion.
const SCOPE_RESEARCH_RING = ['notes', 'reference', 'agents']; // fully-private, read-only, no egress
const SCOPE_RESEARCH_SYS = 'You PLAN a task before its agent is granted powers. Use ONLY your private read-only tools (search notes, consult library/Wikipedia, inspect agent capabilities) for a few round-trips if useful. Then reply with: (a) the concrete STEPS the agent will take to finish end to end, and (b) the capabilities each step needs — being explicit about any step that PRODUCES output (publishing a page/graph/site, writing files, generating an image, posting) and the write-power it requires. Do NOT perform the task — just plan it so the right powers get granted up front.';
// Two-stage: (1) a confined PRIVATE-domain agent researches the task (real round-trips), then
// (2) a deterministic extraction turns task + research into the minimal power list. The research
// genuinely informs the proposal; stage 2 guarantees a parseable JSON array.
const scopePowers = async (task, emit = null) => {
  let research = '';
  try { const r = await runScheduledAgent({ powers: SCOPE_RESEARCH_RING, prompt: String(task), persona: SCOPE_RESEARCH_SYS, model: 'default', emit }); research = String(r.answer || '').slice(0, 1500); } catch (e) { log('scope research', e.message); }
  const userMsg = scopeUser(task) + (research ? `\n\nPrivate research on this task found:\n${research}` : '');
  try { const r = await callLLM([{ role: 'system', content: SCOPE_SYS }, { role: 'user', content: userMsg }], 'default'); const p = parsePowers(r.text); if (p.length) return { proposed: withOutputPowers(p, task), by: research ? 'research+gemma' : 'gemma' }; } catch (e) { log('scope gemma', e.message); }
  try { const r = await opusComplete({ system: SCOPE_SYS, prompt: userMsg, maxTokens: 300 }); const p = parsePowers(String(r || '')); return { proposed: withOutputPowers(p, task), by: research ? 'research+claude' : 'claude' }; } catch (e) { log('scope claude', e.message); }
  return { proposed: withOutputPowers([], task), by: 'none' };
};

// Voice-note ingest is PROPOSE-ONLY: the agent takes NO actions, it produces proposed action items
// (and, via the scoper, names the capabilities an attenuated agent would need to carry them out).
// A pure completion (no toolbox) → it literally cannot act. gemma → Claude fallback.
const INGEST_PERSONA = 'You received a VOICE NOTE transcript. You take NO actions whatsoever. Output a SHORT bulleted list of the concrete action items it implies. For any item that needs real work, note that a dedicated attenuated agent could be spun up for it. Be concise — proposals only, no preamble.';
const ingestPropose = async transcript => {
  let proposals = '';
  try { const r = await callLLM([{ role: 'system', content: INGEST_PERSONA }, { role: 'user', content: transcript }], 'default'); proposals = String(r.text || '').trim(); } catch (e) { log('ingest gemma', e.message); }
  if (!proposals) { try { proposals = String((await opusComplete({ system: INGEST_PERSONA, prompt: transcript, maxTokens: 700 })) || '').trim(); } catch (e) { log('ingest claude', e.message); } }
  const { proposed } = await scopePowers(transcript);
  return { proposals: proposals || '(could not analyze the note)', powers: proposed };
};
const parsePowers = text => {
  const m = String(text || '').match(/\[[^\]]*\]/);
  let arr = []; try { arr = JSON.parse(m ? m[0] : '[]'); } catch { arr = []; }
  return [...new Set((Array.isArray(arr) ? arr : []).map(String).filter(p => ALL_POWERS.includes(p)))];
};
// Deterministic backstop: if the TASK clearly needs an OUTPUT/write power, ensure it's included even when
// the LLM (biased to least-privilege) dropped it — the #1 cause of a build stalling for lack of a power.
const OUTPUT_HINTS = [
  { re: /\b(publish|deploy|web ?page|webpage|render|graph|diagram|chart|dashboard|widget|html|site|app|build (a|an|the)|make (a|an|the).*(page|site|app|graph|chart|tool)|write .* file|save .* file)\b/i, power: 'home' },
  { re: /\b(image|picture|photo|logo|draw|illustrat|render an image|generate .* image)\b/i, power: 'images' },
  { re: /\b(write|edit|update|append|add to) .* note|note edit/i, power: 'editNote' },
  { re: /\b(post (to|on) (the )?feed|notify|notification|remind)\b/i, power: 'feed' },
];
const withOutputPowers = (proposed, task) => {
  const out = [...proposed];
  for (const h of OUTPUT_HINTS) if (h.re.test(String(task || '')) && ALL_POWERS.includes(h.power) && !out.includes(h.power)) out.push(h.power);
  return out;
};

// ── scheduled-agent execution (Project clock-icon / recurring self-improvement) ──
// Run one Project scheduled agent NOW: attenuated to its tool ring, bound to the Project's
// shared home folder, then post the outcome to the dashboard feed (proposals it raised remain
// pending dan's confirm). Returns the run result. Used by /projects/agents/run + the tick.
// ── meeting mode (multi-speaker diarization) — meetingScribe wired to the live app ──
// Single-shot: the client records the whole meeting, we diarize the full clip once (consistent
// speaker labels — sidesteps the cross-chunk stitching limitation), persist the TRANSCRIPT
// per-cap (raw audio is NOT stored server-side), and return speaker-labelled segments.
const meetingScribe = makeMeetingScribe();
const MEETINGS_DIR = `${HOME}/.local/state/voice-agent/meetings`;
const SHARED_DIR = `${HOME}/.local/state/voice-agent/shared-chats`; // Feature B: token → shared chat
const sharePurses = new Map(); // share token → allowance purse (bounds a write-recipient's spend)
// Durable share-allowance purses: persisted via purseStore under a `share:` namespace (token is hashed,
// never on disk), so a funded share survives a restart instead of resetting.
const SHARE_KEY = tok => `share:${tok}`;
const fundSharePurse = (tok, uusd) => { const p = makePurse(Math.round(uusd) || 0, { onChange: (b, g) => purseStore.set(SHARE_KEY(tok), b, g) }); purseStore.set(SHARE_KEY(tok), p.balance(), p.granted()); sharePurses.set(tok, p); return p; };
const unfundSharePurse = tok => { sharePurses.delete(tok); purseStore.remove(SHARE_KEY(tok)); };
const sharePurseFor = tok => {
  let p = sharePurses.get(tok);
  if (!p) { const saved = purseStore.get(SHARE_KEY(tok)); if (saved) { p = makePurse(saved.balance, { granted: saved.granted, onChange: (b, g) => purseStore.set(SHARE_KEY(tok), b, g) }); sharePurses.set(tok, p); } }
  return p || null;
};
const capHash = c => crypto.createHash('sha256').update(String(c || '')).digest('hex').slice(0, 16);

const FEED_DIR = path.dirname(FEED_FILE);
const postFeed = async entry => {
  try {
    await fs.promises.mkdir(FEED_DIR, { recursive: true });
    let feed = { entries: [] }; try { feed = JSON.parse(await fs.promises.readFile(FEED_FILE, 'utf8')); } catch {}
    feed.entries = [{ id: `sched-${crypto.randomBytes(6).toString('hex')}`, date: new Date().toISOString(), kind: 'notification', ...entry }, ...(feed.entries || [])].slice(0, 400);
    await fs.promises.writeFile(FEED_FILE, JSON.stringify(feed, null, 2));
  } catch (e) { log('postFeed', e.message); }
};
const runProjectAgent = async (project, agent) => {
  log('scheduled-agent:', project.name, '›', agent.name, '| tools:', (agent.tools || []).join(','));
  let out;
  try {
    out = await runScheduledAgent({ powers: agent.tools || [], homeSubkey: project.homeSubkey, prompt: agent.prompt, persona: getPersona(), model: agent.model || 'default' });
  } catch (e) { out = { ok: false, error: e.message }; }
  const nProp = (out.proposalIds || []).length;
  const now = new Date().toISOString();
  const answer = String(out.ok ? out.answer : `run failed: ${out.error}`);
  const usedTools = out.toolsUsed || [];
  // Persist the run as a reviewable, CONTINUABLE chat (a seed-chat) so it lands in history with evidence —
  // not just a dead-end notification. loadSeedChats adopts it into the sidebar; #chat=<id> deep-links to it.
  const id = `chat-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const seed = {
      id, title: `⏰ ${project.name} › ${agent.name}`, ts: Date.now(), source: 'scheduled',
      transcript: agent.prompt, scheduled: { project: project.name, agent: agent.name, at: now, tools: out.grantedPowers || agent.tools || [] },
      tx: [{ who: 'you', text: agent.prompt }, { who: 'agent', text: answer, tools: usedTools, steps: [] }],
      versions: [{ v: 0, label: 'scheduled run', env: { persona: `scheduled:${agent.name}` }, answer, toolsUsed: usedTools, steps: [], at: now }],
    };
    const seeds = await readSeedChats(); seeds.unshift(seed); await writeSeedChats(seeds);
  } catch (e) { log('sched seed-chat', e.message); }
  await postFeed({
    agent: agent.name, avatar: '⏰', title: `${project.name} › ${agent.name}`,
    body: answer.slice(0, 400),
    status: nProp ? `needs your input · ${nProp} proposal(s)` : 'ran', note: `tools: ${(out.grantedPowers || agent.tools || []).join(', ')}`,
    chatId: id, click: `${BASE_URL}/#chat=${id}`, // tapping the notification opens the run
  });
  projects.recordAgentRun(project.id, agent.id, { nextAt: projects.computeNextAt(agent.schedule, Date.now()), lastRun: Date.now(), lastRunChatId: id });
  return { ...out, chatId: id };
};

const sessions = new Map(); // sessionId → [{role,content}...]
const runs = new Map();     // sessionId → AbortController (barge-in cancel)
// ── live step stream (the inline 3D "pendant"): per-session SSE writers. Carries ONLY
//    tool NAMES + ok/children (no cap, no payload) so the chat can animate the fan-out in
//    real time. Keyed by sessionId; cap-hygiene preserved (the swissnum never rides this URL). ──
const stepStreams = new Map(); // sessionId → Set<res>
const emitStep = (sid, obj) => { const set = stepStreams.get(sid); if (!set || !set.size) return; const line = `data: ${JSON.stringify(obj)}\n\n`; for (const r of set) { try { r.write(line); } catch { /* dropped */ } } };
// a short "what did this action do" string for inspection — the query/url/path/prompt (no contents, no cap).
const detailFromArgs = (a) => { if (!a || typeof a !== 'object') return ''; const v = a.query || a.url || a.path || a.q || a.prompt || a.task || a.cmd || a.message || a.title || ''; return String(v || '').slice(0, 200); };
// Full-but-bounded text of a tool invocation / result, for the trace's inspectable modal.
// CAP-HYGIENE: never leak a swissnum/secret into the trace, and never ship a base64 blob (e.g. a PNG).
const SECRET_KEY = /swiss|secret|token|password|authorization|api[_-]?key|cookie|\bcap\b/i;
const safeText = (v, cap) => {
  const seen = new WeakSet(); let s;
  try {
    s = JSON.stringify(v, (k, val) => {
      if (k && SECRET_KEY.test(k)) return '«redacted»';
      if (typeof val === 'string') return val.length > 4000 ? `${val.slice(0, 4000)}… (+${val.length - 4000} chars)` : val;
      if (val && typeof val === 'object') { if (seen.has(val)) return '«circular»'; seen.add(val); }
      return val;
    }, 2);
  } catch { try { s = String(v); } catch { s = ''; } }
  if (s === undefined || s === null) return '';
  s = String(s).replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, '«base64 data elided»');
  return s.length > cap ? `${s.slice(0, cap)}\n… (truncated, ${s.length} chars total)` : s;
};
// build the rich, persisted research subtree (sub-questions → their search/fetches; summary as inspectable info)
// from a runResearch result, so a re-opened chat re-renders the full inspectable tree (not just at live time).
const researchTree = (result) => {
  const findings = (result && result.findings) || [];
  const kids = findings.map(f => {
    const used = f.used || []; const ch = [];
    if (used.includes('webSearch')) ch.push({ name: 'webSearch', detail: f.q || '' });
    for (const u of (f.sources || [])) ch.push({ name: 'fetchUrl', detail: String(u) });
    if (used.includes('consult')) ch.push({ name: 'consult', detail: f.q || '' });
    const okSub = !!f.summary && !String(f.summary).startsWith('(');
    return { name: `❓ ${String(f.q || '').slice(0, 40)}`, detail: f.q || '', info: f.summary || '', ok: okSub, children: ch };
  });
  if (result && result.report) kids.push({ name: 'report', detail: '', info: String(result.report).slice(0, 600) });
  return kids;
};

const SEC = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'payment=(), interest-cohort=(), browsing-topics=()',
  // frame-src: agentc may embed its OWN widgets ('self', incl. srcdoc) AND inline fleet SPWAs on the
  // loopback/tailnet origins (their frame-ancestors reciprocally allow agentc). Without this, default-src
  // 'self' blocks framing any cross-origin fleet app. (X-Frame-Options above still keeps OTHERS from framing agentc.)
  'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' http://localhost:* http://127.0.0.1:* http://100.83.80.102:* http://*.taildd002.ts.net:* https://*.taildd002.ts.net; base-uri 'none'; form-action 'self'",
};
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...SEC }); res.end(JSON.stringify(obj)); };
// no-STORE the app shell (index.html/app.js/pendant.js/…) so an actively-developed client can't get
// stuck on a stale cached copy (iOS Safari ignores no-cache for module scripts) — only the big vendored
// libs (three.module.js) keep revalidate-caching. This ends the "still broken after you deployed" cycle.
const serveFile = async (res, rel, type) => { try { const cc = rel === 'three.module.js' ? 'no-cache' : 'no-store, must-revalidate'; res.writeHead(200, { 'content-type': type, 'cache-control': cc, ...SEC }); res.end(await fs.promises.readFile(path.join(HERE, 'public', rel))); } catch { res.writeHead(404, SEC); res.end('not found'); } };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const mimeFor = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const rawBody = req => new Promise(resolve => { const ch = []; let n = 0; req.on('data', c => { ch.push(c); n += c.length; if (n > 25 * 1024 * 1024) req.destroy(); }); req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', () => resolve(Buffer.alloc(0))); });
const jsonBody = async req => { try { return JSON.parse((await rawBody(req)).toString('utf8') || '{}'); } catch { return {}; } };

// Common whisper hallucinations on silence / ambient noise / keyboard clatter —
// it invents stock phrases (often in other languages, or "thanks for watching").
// We force English + greedy decode + VAD below; this catches the residue.
const NOISE = [/^you\b/i, /^thank(s| you)/i, /^thanks for watching/i, /^bye\b/i, /^okay\b\.?$/i, /subscrib/i, /^\W*$/, /^(uh|um|hmm|ah|oh)\W*$/i, /продолжение/i, /^vamos/i, /^gracias/i, /\.{3,}$/];
const looksLikeNoise = t => !t || t.length < 2 || (t.split(/\s+/).length <= 3 && NOISE.some(re => re.test(t)));

const transcribe = async (bytes, mime = 'audio/webm') => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), 'speech.webm');
  fd.append('model', STT_MODEL);
  fd.append('language', process.env.STT_LANG || 'en'); // English only — kills foreign-language hallucinations
  fd.append('temperature', '0');                       // greedy decode — fewer invented words
  fd.append('vad_filter', 'true');                     // drop non-speech (ambient noise / keyboard)
  const r = await fetch(WHISPER, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`STT ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const text = ((await r.json()).text || '').trim();
  return looksLikeNoise(text) ? '' : text; // empty → client says "(didn’t catch that)", no /chat call
};

// ── attachments: a turn may carry images/files the user attached in chat. Images
//    go to the agent as inline image_url blocks (gemma on tinix SEES them — local,
//    no cloud) AND are saved under a web-key'd /uploads/<hex> so the chat history can
//    re-show them across devices. Text files are inlined. The filename hex IS the
//    credential to fetch it back (same web-key model as /sites). ─────────────────
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heic' };
const MAX_ATT = 4;
const MAX_DECODED = 12 * 1024 * 1024; // per attachment, after base64-decode
const HEIFCONVERT = ['/usr/bin/heif-convert', '/usr/local/bin/heif-convert'].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
const dataUrlParts = url => { const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(url || '')); return m ? { mime: (m[1] || 'application/octet-stream').toLowerCase(), b64: !!m[2], data: m[3] } : null; };
// gemma vision wants jpeg/png; transcode HEIC if the tool's present (iOS Safari often pre-converts, so this is the fallback).
const transcodeHeic = async bytes => {
  if (!HEIFCONVERT) return null;
  const stem = path.join(UPLOADS, `tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fs.promises.mkdir(UPLOADS, { recursive: true });
    await fs.promises.writeFile(`${stem}.heic`, bytes);
    await new Promise((resolve, reject) => execFile(HEIFCONVERT, [`${stem}.heic`, `${stem}.jpg`], { timeout: 30000 }, e => (e ? reject(e) : resolve())));
    return await fs.promises.readFile(`${stem}.jpg`);
  } catch { return null; }
  finally { fs.promises.rm(`${stem}.heic`, { force: true }).catch(() => {}); fs.promises.rm(`${stem}.jpg`, { force: true }).catch(() => {}); }
};
// Drop an attachment's bytes into the chat's home folder (the agent's own folder — it
// can read/move/process it). Collision-safe; returns the relative name written, or null.
const saveToHome = (homeSubkey, name, bytes) => {
  if (!homeSubkey) return null;
  try {
    const dir = path.join(HOME_BASE, homeSubkey);
    fs.mkdirSync(dir, { recursive: true });
    let base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    if (fs.existsSync(path.join(dir, base))) { const ext = path.extname(base); base = `${base.slice(0, base.length - ext.length)}-${crypto.randomBytes(3).toString('hex')}${ext}`; }
    fs.writeFileSync(path.join(dir, base), bytes);
    return base;
  } catch (e) { log('home-save', e.message); return null; }
};
// → { agentAttachments: [{kind:'image',url:dataURL}|{kind:'text',name,text}], savedRefs: [{kind,url?,mediaType?,name}] }
// homeSubkey: when set, NON-image attachments (text + arbitrary files) are ALSO dropped into that
// home folder so the agent can read/move/process them as its own files.
const processAttachments = async (list, homeSubkey = null) => {
  const agentAttachments = []; const savedRefs = [];
  if (!Array.isArray(list)) return { agentAttachments, savedRefs };
  for (const a of list.slice(0, MAX_ATT)) {
    try {
      if (a && a.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
        const name = String(a.name || 'file').slice(0, 120);
        const saved = saveToHome(homeSubkey, name, Buffer.from(a.text, 'utf8'));
        agentAttachments.push({ kind: 'text', name, text: a.text.slice(0, 40000) + (saved ? `\n\n[saved to your home folder as ./${saved}]` : '') });
        savedRefs.push({ kind: 'text', name, home: saved || undefined });
        continue;
      }
      const p = dataUrlParts(a && a.url);
      if (!p) continue;
      let mime = (a && a.mediaType ? String(a.mediaType) : p.mime).toLowerCase();
      let ext = IMG_EXT[mime];
      if (!ext) {
        // arbitrary (non-image) file → drop it into the agent's home folder + tell the agent.
        const bytes = Buffer.from(p.data, p.b64 ? 'base64' : 'utf8');
        if (!bytes.length || bytes.length > MAX_DECODED) continue;
        const name = String((a && a.name) || 'file').slice(0, 120);
        const saved = saveToHome(homeSubkey, name, bytes);
        if (saved) {
          agentAttachments.push({ kind: 'text', name, text: `[A file "${name}" (${bytes.length} bytes, ${mime}) was attached and saved to your home folder as ./${saved}. It is yours — read, move, rename, or process it with your home-folder tools (fileList/fileRead/fileWrite).]` });
          savedRefs.push({ kind: 'file', name, home: saved });
        }
        continue;
      }
      let bytes = Buffer.from(p.data, p.b64 ? 'base64' : 'utf8');
      if (!bytes.length || bytes.length > MAX_DECODED) continue;
      if (mime === 'image/heic' || mime === 'image/heif') {
        const conv = await transcodeHeic(bytes);
        if (!conv) continue; // can't make it viewable for gemma — drop rather than send garbage
        bytes = conv; mime = 'image/jpeg'; ext = 'jpg';
      }
      const fname = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      await fs.promises.mkdir(UPLOADS, { recursive: true });
      await fs.promises.writeFile(path.join(UPLOADS, fname), bytes);
      agentAttachments.push({ kind: 'image', url: `data:${mime};base64,${bytes.toString('base64')}` });
      savedRefs.push({ kind: 'image', url: `/uploads/${fname}`, mediaType: mime, name: String((a && a.name) || 'image').slice(0, 120) });
    } catch (e) { log('attach', e.message); }
  }
  return { agentAttachments, savedRefs };
};

const handler = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/' || u.pathname === '/index.html') return serveFile(res, 'index.html', 'text/html; charset=utf-8');
    if (u.pathname === '/app.js') return serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/qrcode.js') return serveFile(res, 'qrcode.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/trace.js') return serveFile(res, 'trace.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/pendant.js') return serveFile(res, 'pendant.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/three.module.js') return serveFile(res, 'three.module.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/cap-channel.js') return serveFile(res, 'cap-channel.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/trace-app.js') return serveFile(res, 'trace-app.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/widget.js') return serveFile(res, 'widget.js', 'text/javascript; charset=utf-8');
    // confined-Preact islands bundle (built by `yarn build:islands`) + its sourcemap
    if (u.pathname === '/islands/islands.js') return serveFile(res, 'islands/islands.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/islands/islands.js.map') return serveFile(res, 'islands/islands.js.map', 'application/json; charset=utf-8');
    // standalone iframe apps — framed SAME-ORIGIN by the SPA (override XFO:DENY)
    if (u.pathname === '/trace-app.html' || u.pathname === '/widget.html') {
      const f = u.pathname.slice(1);
      try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...SEC, 'x-frame-options': 'SAMEORIGIN' }); res.end(await fs.promises.readFile(path.join(HERE, 'public', f))); }
      catch { res.writeHead(404, SEC); res.end('not found'); }
      return;
    }

    // ── static host for agent-published sites: /sites/<token>/<path> ───────────
    // The unguessable token (a web-key) is the access credential. Served with a
    // sandbox CSP so an agent-built page can't reach the field-agent's own origin
    // APIs; the page can carry its own inline html/css/js + images/data URLs.
    if (u.pathname.startsWith('/sites/')) {
      const m = /^\/sites\/([0-9a-f]+)(?:\/(.*))?$/.exec(u.pathname);
      const dir = m && siteDir(m[1]);
      if (!dir) { res.writeHead(404, SEC); res.end('unknown or revoked site'); return; }
      let rel = decodeURIComponent(m[2] || ''); if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const abs = path.resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + path.sep)) { res.writeHead(403, SEC); res.end('forbidden'); return; }
      try {
        const buf = await fs.promises.readFile(abs);
        res.writeHead(200, { 'content-type': mimeFor(abs), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; base-uri 'none'; form-action 'none'" });
        res.end(buf);
      } catch { res.writeHead(404, SEC); res.end('not found'); }
      return;
    }

    // ── user-attached images: /uploads/<hex>.<ext>. The unguessable hex name is the
    //    access credential (web-key), like /sites. Served as a fixed image type with
    //    a locked-down CSP so an upload can never be interpreted as active content. ─
    if (u.pathname.startsWith('/uploads/')) {
      const m = /^\/uploads\/([0-9a-f]{16,}\.(?:png|jpg|jpeg|webp|gif))$/.exec(u.pathname);
      if (!m) { res.writeHead(404, SEC); res.end('not found'); return; }
      try {
        const buf = await fs.promises.readFile(path.join(UPLOADS, m[1]));
        res.writeHead(200, { 'content-type': mimeFor(m[1]), 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
        res.end(buf);
      } catch { res.writeHead(404, SEC); res.end('not found'); }
      return;
    }

    // ── management surface: dispatch a method against the cap a swissnum names ──
    if (req.method === 'POST' && u.pathname === '/rpc') {
      const { swissnum, method, args = [] } = await jsonBody(req);
      const node = nodeFor(swissnum);
      if (!node) return json(res, 404, { ok: false, error: 'unknown or revoked capability' });
      try { const result = await E(node.cap)[method](...(Array.isArray(args) ? args : [])); return json(res, 200, { ok: true, result }); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }

    if (req.method === 'POST' && u.pathname === '/stt') {
      const bytes = await rawBody(req);
      if (!bytes.length) return json(res, 400, { error: 'no audio' });
      try { return json(res, 200, { text: await transcribe(bytes, req.headers['content-type'] || 'audio/webm') }); }
      catch (e) { log('stt', e.message); return json(res, 502, { error: e.message }); }
    }

    // ── meeting mode: diarize a full recorded clip → speaker-labelled segments. The cap rides
    //    in the x-cap header (binary body), so the swissnum stays out of the URL/access log. ──
    if (req.method === 'POST' && u.pathname === '/meeting/transcribe') {
      const cap = req.headers['x-cap'];
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability — open this app with your #cap= link' });
      const bytes = await rawBody(req);
      if (!bytes.length) return json(res, 400, { error: 'no audio' });
      try {
        const sid = meetingScribe.start({});
        await meetingScribe.ingest(sid, bytes, req.headers['content-type'] || 'audio/webm');
        const out = meetingScribe.end(sid); // { transcript, speakers, segments }
        try { // persist transcript-only per cap (raw audio is never stored server-side)
          const dir = path.join(MEETINGS_DIR, capHash(cap)); await fs.promises.mkdir(dir, { recursive: true });
          const rec = { id: `mtg-${crypto.randomBytes(6).toString('hex')}`, at: new Date().toISOString(), ...out };
          await fs.promises.writeFile(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
          return json(res, 200, { ...out, id: rec.id });
        } catch (e) { log('meeting persist', e.message); return json(res, 200, out); } // diarization still succeeded
      } catch (e) { log('meeting', e.message); return json(res, 502, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/meeting/list') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      try {
        const dir = path.join(MEETINGS_DIR, capHash(cap));
        let files = []; try { files = await fs.promises.readdir(dir); } catch {}
        const items = (await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => {
          try { const r = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8')); return { id: r.id, at: r.at, speakers: r.speakers, transcript: r.transcript }; } catch { return null; }
        }))).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50);
        return json(res, 200, { meetings: items });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // ── live step stream for the inline 3D pendant (SSE). Keyed by sessionId only;
    //    carries tool NAMES + ok/children, never the cap or any payload (cap-hygiene). ──
    if (req.method === 'GET' && u.pathname === '/chat/steps') {
      const sid = String(u.searchParams.get('sid') || 'anon').slice(0, 64);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SEC });
      res.write(': ok\n\n');
      let set = stepStreams.get(sid); if (!set) { set = new Set(); stepStreams.set(sid, set); } set.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(hb); set.delete(res); if (!set.size) stepStreams.delete(sid); });
      return undefined; // keep the connection open
    }

    // ── voice/text turn: the cap decides the agent's reach. No cap → no powers. ──
    if (req.method === 'POST' && u.pathname === '/chat') {
      const { sessionId, text, cap, attachments, model, history: clientHistory, agent } = await jsonBody(req);
      const t = String(text || '').trim();
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability — open this app with your #cap= link to grant the agent powers' });
      // Entrypoint agent: 'field-agent' (Agent C) runs as the cap itself. Any other value names a
      // SPECIALIST to run AS — the turn executes with the specialist's CONFINED ring + persona (not
      // root). Only a cap that OWNS specialists (root, or one holding `specialists`) may act as one.
      let runNode = node, runPersona = getPersona();
      if (agent && agent !== 'field-agent' && (node.isRoot || node.powers.has('specialists'))) {
        const spec = specialistFor(agent);
        if (spec) { runNode = spec.node; runPersona = spec.persona || getPersona(); }
      }
      const sid0 = String(sessionId || 'anon').slice(0, 64);
      // the chat's home folder: its project's shared folder if filed under one, else the root agent's home.
      const chatProject = runNode.isRoot ? projects.projectForChat(sid0) : null;
      const chatHomeSubkey = chatProject ? chatProject.homeSubkey : (runNode.isRoot ? 'root' : null);
      const { agentAttachments, savedRefs } = await processAttachments(attachments, chatHomeSubkey);
      if (!t && !agentAttachments.length) return json(res, 400, { error: 'empty' });
      const sid = sid0;
      runs.get(sid)?.abort();
      const ac = new AbortController(); runs.set(sid, ac);
      // bind the app-state accessor to THIS cap + close over it (the swissnum never enters ctx — cap-hygiene).
      // ROOT-ONLY: the memo/seed/asks/feed stores are GLOBAL, so only the full root agent gets app-state —
      // a shared/sub-agent cap (which holds a confined subset) would otherwise see/mutate everything.
      const boundApp = runNode.isRoot ? harden({ listChats: () => appStore.listChats(cap), readChat: id => appStore.readChat(cap, id), retitle: (id, title) => appStore.retitle(cap, id, title), summary: () => appStore.summary(cap) }) : undefined;
      // the turn's purse + a `charge` that paid connectors (Phase 4) debit market-rate+commission from.
      const purse = purseFor(cap, sid);
      const charge = uusd => { const amt = Math.max(0, Math.round(Number(uusd) || 0)); if (!amt) return true; if (!purse.canAfford(amt)) return false; purse.debit(amt); return true; };
      const { toolbox, manifest } = runNode.toolbox({ chatId: sid, userText: t, emit: ev => emitStep(sid, ev), app: boundApp, homeSubkey: chatProject ? chatProject.homeSubkey : null, charge }); // chatId → deep-links; userText → delegates/specialists carry the originating request; emit → pendant stream; app → root state; homeSubkey → project folder; charge → paid-connector billing
      // Conversation memory: PREFER the client's durable transcript (it survives this service being
      // restarted — the in-memory `sessions` map is volatile and capped, which made the agent forget
      // earlier turns after every deploy). Fall back to the in-process map only if the client sent none.
      const history = (Array.isArray(clientHistory) && clientHistory.length)
        ? clientHistory.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content) })).slice(-24)
        : (sessions.get(sid) || []);
      const images = [];      // data-URLs for live render + this-session 3D trace (stripped before persist)
      const imageUrls = [];    // durable /uploads copies of the SAME images → survive a chat reload
      const proposalIds = [];
      const autoFired = []; // destructive actions that auto-confirmed via a "don't ask again" rule
      const askIds = []; // structured typed questions the agent raised this turn (rendered inline)
      const steps = []; // ordered tool calls this turn; delegateTask nests its sub-agent's tools (sub-branch trees)
      log('chat:', JSON.stringify(t).slice(0, 80), '| powers:', [...runNode.powers].join(','), agent && agent !== 'field-agent' ? `| as:${agent}` : '', agentAttachments.length ? `| +${agentAttachments.length} attachment(s)` : '');
      // prepaid inference toll-bridge: meter THIS chat's purse; show the agent its budget in-context.
      const perProvider = {};
      const meteredLLM = makeMeteredLLM({ callLLM, purse, perProvider });
      const TURN_DEADLINE_MS = Number(process.env.TURN_DEADLINE_MS) || 360000; // hard per-turn limit → a LEGIBLE timeout, never a silent stall (the crowdsupply hang)
      let deadlineHit = false; let deadlineT = null;
      const r = await Promise.race([
        AGENT_RUNNER({
        toolbox, manifest, userText: t, history, attachments: agentAttachments, signal: ac.signal, persona: runPersona, model: String(model || 'default'),
        llm: meteredLLM, budgetLine: budgetLine(purse.balance(), String(model || 'default')),
        onStep: s => {
          if (s.kind === 'tool-start') { emitStep(sid, { t: 'start', name: s.name, detail: detailFromArgs(s.args), call: safeText(s.args, 16000) }); return; } // the pendant grows a node (with its exact call) the instant a tool is invoked
          if (s.kind !== 'tool') return;
          // NB: do NOT bail on a falsy result. Many tools/live-object methods legitimately return
          // undefined/null/''/false (an action verb, a void method). If we skipped those, the node
          // spawned at tool-start would never settle and never show a result — the "some tools don't
          // render their responses" bug. Always settle; render a placeholder when there's no value.
          const rv = (s.result && typeof s.result === 'object') ? s.result : {};
          if (rv.savedTo && String(rv.savedTo).endsWith('.png')) {
            try { images.push('data:image/png;base64,' + fs.readFileSync(rv.savedTo).toString('base64')); } catch {}
            // also keep a durable, web-key'd copy so the image is still there when the chat is re-opened
            // (the data-URL above is dropped before persisting — it would blow the localStorage quota).
            try { const fname = `${crypto.randomBytes(16).toString('hex')}.png`; fs.copyFileSync(rv.savedTo, path.join(UPLOADS, fname)); imageUrls.push(`/uploads/${fname}`); } catch (e) { log('imgcopy', e.message); }
          }
          if (rv.proposed && rv.id) proposalIds.push(rv.id); // a destructive action was PROPOSED, not done
          if (rv.autoConfirmed) autoFired.push({ title: rv.title, type: rv.type, ok: rv.fired !== false }); // "don't ask again" fired it
          if (rv.asked && rv.askId) askIds.push(rv.askId); // the agent raised a typed question → render it inline
          if (Array.isArray(rv.proposalIds)) proposalIds.push(...rv.proposalIds); // nested (specialist) proposals bubble up
          if (Array.isArray(rv.autoFired)) autoFired.push(...rv.autoFired);
          const step = { name: s.name, ok: rv.ok !== false };
          const det = detailFromArgs(s.args); if (det) step.detail = det;
          const callText = safeText(s.args, 16000);
          let resultText = safeText(s.result, 24000); // EXACT invocation + EXACT result for the inspectable trace
          if (!resultText) resultText = (s.result === undefined ? '(ok — no value returned)' : safeText({ value: s.result }, 24000) || '(ok)'); // never leave the node result-less
          if (callText) step.call = callText.slice(0, 4000); // persisted (bounded so the chat store stays small); the live SSE carries the fuller text
          if (resultText) step.result = resultText.slice(0, 4000);
          if (s.name === 'research' && Array.isArray(rv.findings)) step.children = researchTree(rv); // rich subtree (sub-questions + searches + summaries) for persistence + inspection
          else if ((s.name === 'delegateTask' || s.name === 'askSpecialist' || s.name === 'employ') && Array.isArray(rv.toolsUsed)) step.children = rv.toolsUsed.map(x => ({ name: x.name || String(x), detail: x.args ? detailFromArgs(x.args) : '', call: x.args ? safeText(x.args, 4000) : '', result: x.result !== undefined ? safeText(x.result, 4000) : '' })); // carry the sub-agent's exact call + RESULT so a child (e.g. agentExec) shows its content, not just its name
          // Granovetter edge: the powers this delegation GRANTED to the sub-agent (from the call's
          // `powers`/`tools` arg or the result's grantedPowers) → the trace draws them as edge icons.
          const granted = (s.args && (Array.isArray(s.args.powers) ? s.args.powers : Array.isArray(s.args.tools) ? s.args.tools : null)) || (Array.isArray(rv.grantedPowers) ? rv.grantedPowers : null);
          if (granted && granted.length) step.granted = granted.filter(p => typeof p === 'string');
          steps.push(step);
          emitStep(sid, { t: 'done', name: step.name, ok: step.ok, detail: step.detail, children: step.children, call: callText, result: resultText, granted: step.granted }); // the node settles live (research's live subtree already streamed via rnode)
        },
        }).then(x => { if (deadlineT) clearTimeout(deadlineT); return x; }),
        new Promise(resolve => { deadlineT = setTimeout(() => { deadlineHit = true; try { ac.abort(); } catch { /* */ } resolve({ cancelled: true, toolsUsed: [], answer: '' }); }, TURN_DEADLINE_MS); }),
      ]);
      emitStep(sid, { t: 'end' });
      if (runs.get(sid) === ac) runs.delete(sid);
      // WATCHDOG: the turn blew the deadline (or never returned). Surface a LEGIBLE summary instead of a
      // silent cancel — name the steps it ran + the last one (the likely stall), so failures are visible.
      if (deadlineHit || r.timedOut) {
        const names = steps.map(s => s.name).filter(Boolean);
        const last = names[names.length - 1];
        const mins = Math.round(TURN_DEADLINE_MS / 60000);
        const answer = `⚠️ I stopped this run after ${mins} min (the turn time limit). ` + (names.length
          ? `It ran ${names.length} step(s): ${names.join(' → ')}. The last one (${last}) didn't return in time — that's the likely stall.`
          : `It produced no steps — it stalled before the first action (a tool likely hung).`) + ` Tell me to retry, or narrow it to the part that matters.`;
        return json(res, 200, { answer, steps, toolsUsed: names.map(n => ({ name: n })), agentId: runNode.id, timedOut: true, remaining: purse.balance(), allowance: purse.granted() });
      }
      if (r.cancelled) return json(res, 200, { cancelled: true });
      // prepaid allowance spent mid-turn → return a DETERMINISTIC exhausted signal (no model
      // call was made to produce it). The client renders a static Top-up / Abandon card.
      if (r.exhausted) return json(res, 200, { exhausted: true, answer: r.answer || '', remaining: purse.balance(), allowance: purse.granted() });
      // history keeps the multimodal user content so a follow-up can still refer to the attached image.
      const next = [...history, { role: 'user', content: buildUserContent(t, agentAttachments) }, { role: 'assistant', content: r.answer }].slice(-12);
      sessions.set(sid, next);
      const proposals = proposalIds.map(getProposal).filter(Boolean);
      const asks = askIds.map(getAsk).filter(Boolean); // typed questions raised this turn → rendered inline
      return json(res, 200, { answer: r.answer, images, imageUrls, toolsUsed: r.toolsUsed.map(x => x.name), steps, proposals, autoFired, asks, agentId: runNode.id, attachments: savedRefs, remaining: purse.balance(), allowance: purse.granted(), spent: Object.values(perProvider).reduce((a, b) => a + b, 0), perProvider });
    }

    if (req.method === 'POST' && u.pathname === '/cancel') {
      const { sessionId } = await jsonBody(req);
      const sid = String(sessionId || 'anon').slice(0, 64);
      runs.get(sid)?.abort(); runs.delete(sid);
      return json(res, 200, { cancelled: true });
    }

    // ── prepaid inference budget (Increment 1): read + adjust a conversation's µUSD
    //    allowance. Amounts are µUSD integers. Any valid cap manages its OWN chats'
    //    purses; only root may move the global default-allowance for new chats. ──
    // ── TOLL-BRIDGE: the SPWA self-editors report EDIT spend (AI credits) + SAVE/HOST rent
    //    (storage×time) here, so both land in the central µUSD ledger. The `account` is a
    //    host-side secret (never in a browser); check/edit/save only DECREASE a balance.
    //    fund is the only credit op and is ROOT-gated — that's how "publishing rights come out
    //    of the allowance you grant when sharing" (fund the sharee's account from their grant). ──
    if (req.method === 'GET' && u.pathname === '/toll/quote') return json(res, 200, { ok: true, ...tollBridge.quote() });
    if (req.method === 'POST' && u.pathname === '/toll/check') { const { account } = await jsonBody(req); return json(res, 200, tollBridge.check(String(account || ''))); }
    if (req.method === 'POST' && u.pathname === '/toll/edit') { const { account, model, usage } = await jsonBody(req); return json(res, 200, tollBridge.chargeEdit({ account: String(account || ''), model, usage })); }
    if (req.method === 'POST' && u.pathname === '/toll/save') { const { account, key, bytes, appName } = await jsonBody(req); return json(res, 200, tollBridge.chargeSave({ account: String(account || ''), key: String(key || ''), bytes: Number(bytes) || 0, appName })); }
    if (req.method === 'POST' && u.pathname === '/toll/unpublish') { const { account, key } = await jsonBody(req); return json(res, 200, tollBridge.unregister(String(account || ''), String(key || ''))); }
    if (req.method === 'POST' && u.pathname === '/toll/account') { const { account } = await jsonBody(req); return json(res, 200, tollBridge.accountStatus(String(account || ''))); }
    if (req.method === 'POST' && u.pathname === '/toll/fund') {
      const { cap, account, amount } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'funding an account is the owner\'s grant — root cap required' });
      return json(res, 200, tollBridge.fund({ account: String(account || ''), uusd: Number(amount) || 0 }));
    }
    if (req.method === 'POST' && u.pathname === '/budget') {
      const { cap, purseCap, sessionId } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      // The turn's purse is keyed by the CHAT's (possibly scoped) cap, so read THAT purse — else the
      // chip shows a different purse than the one inference actually spends.
      const key = nodeFor(purseCap) ? purseCap : cap;
      const p = purseFor(key, String(sessionId || 'anon').slice(0, 64));
      return json(res, 200, { remaining: p.balance(), allowance: p.granted(), defaultAllowance });
    }
    if (req.method === 'POST' && (u.pathname === '/budget/topup' || u.pathname === '/budget/set')) {
      const { cap, purseCap, sessionId, amount } = await jsonBody(req);
      // FREE top-up / set is the OWNER's comp — root only (a non-root invitee adds credit by PAYING,
      // so they can't grant themselves free inference). The root `cap` AUTHORIZES; we credit the CHAT's
      // purse, which is keyed by its (often SCOPED) cap — passed as `purseCap`. (Without this, a scoped
      // chat's top-up credited the root purse, not the one the turn spends → "top-up did nothing".)
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'free credit is the owner\'s to grant — add credit via payment (/pay/checkout)' });
      const amt = Math.max(0, Math.round(Number(amount) || 0));
      const key = nodeFor(purseCap) ? purseCap : cap;
      const p = purseFor(key, String(sessionId || 'anon').slice(0, 64));
      if (u.pathname === '/budget/set') p.set(amt); else p.credit(amt); // set = this chat's allowance; topup = add
      return json(res, 200, { remaining: p.balance(), allowance: p.granted() });
    }
    // ── PHASE 2 BILLING: a non-root user whose allowance is exhausted PAYS to add credit. The purse
    //    stays the real-time meter; Stripe only moves money. Cap-hygiene: the swissnum never goes to
    //    Stripe — a server-side payId maps the webhook back to the purse. ──
    if (req.method === 'POST' && u.pathname === '/pay/checkout') {
      const { cap, sessionId, amountUsd } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      const dollars = Math.max(1, Math.min(100, Number(amountUsd) || 5)); // $1–$100 per top-up
      const cents = Math.round(dollars * 100); const uusd = cents * 10000;
      const cfg = loadStripeCfg();
      if (!cfg) { // not provisioned yet → notify the owner to set up Stripe (the API-key loop)
        await postFeed({ title: '💳 Payment not set up — an invitee wants to add credit', body: `Someone hit their allowance and tried to add $${dollars.toFixed(2)}. Provision Stripe (~/.config/field-agent/stripe.json: {secretKey, webhookSecret}) to enable self-serve top-ups.`, status: '🔔 needs your attention' });
        return json(res, 503, { error: 'payments aren\'t set up yet — the owner has been notified', needsOwner: true });
      }
      const payId = recordPending({ cap, sid: String(sessionId || 'anon').slice(0, 64), uusd, now: new Date().toISOString() });
      const form = checkoutForm({ cents, payId, successUrl: `${cfg.successUrl || BASE_URL}/#paid=1`, cancelUrl: cfg.cancelUrl || BASE_URL });
      let sess; try { sess = await (await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${cfg.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json(); } catch (e) { return json(res, 502, { error: e.message }); }
      if (!sess || !sess.url) return json(res, 502, { error: (sess && sess.error && sess.error.message) || 'stripe error' });
      return json(res, 200, { url: sess.url, amountUsd: dollars });
    }
    if (req.method === 'POST' && u.pathname === '/pay/webhook') {
      const cfg = loadStripeCfg();
      if (!cfg || !cfg.webhookSecret) return json(res, 503, { error: 'payments not set up' });
      const raw = (await rawBody(req)).toString('utf8');
      if (!verifyWebhook(raw, req.headers['stripe-signature'], cfg.webhookSecret)) return json(res, 400, { error: 'bad signature' });
      let evt; try { evt = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const settled = settleEvent(evt); // idempotent: a payId credits at most once
      if (settled) { purseFor(settled.cap, settled.sid).credit(settled.uusd); log('pay', `credited ${settled.uusd}µUSD to ${settled.sid} (payId ${settled.payId})`); }
      return json(res, 200, { received: true });
    }
    // ── BILLING RAIL #3: pay with an ERC-7710 delegation granted via MetaMask advanced permissions
    //    (ERC-7715). The user pre-authorizes a capped, revocable spending allowance (a capability);
    //    our gator-pay settlement service redeems against it to credit the purse. ──
    if (req.method === 'POST' && u.pathname === '/pay/delegation/status') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      return json(res, 200, { available: gatorConfigured() });
    }
    if (req.method === 'POST' && u.pathname === '/pay/delegation/grant') {
      const { cap, sessionId, delegation } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      if (!delegation) return json(res, 400, { error: 'no delegation' });
      recordDelegation({ cap, sid: String(sessionId || 'anon').slice(0, 64), delegation, now: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/pay/delegation/redeem') {
      const { cap, sessionId, amountUsd } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      const dollars = Math.max(1, Math.min(100, Number(amountUsd) || 5));
      const uusd = Math.round(dollars * 1e6); const sid = String(sessionId || 'anon').slice(0, 64);
      const r = await redeemDelegation({ cap, sid, uusd });
      if (!r.ok) {
        if (r.needsOwner) await postFeed({ title: '⛓️ Delegated payment not set up — an invitee wants to pay on-chain', body: 'Run the gator-pay charge-server + add ~/.config/field-agent/gator-pay.json {chargeServerUrl, treasury, weiPerUusd} to enable ERC-7715/7710 settlement.', status: '🔔 needs your attention' });
        return json(res, r.needsOwner ? 503 : 402, { error: r.error, needsOwner: !!r.needsOwner });
      }
      const p = purseFor(cap, sid); p.credit(uusd); // settled on-chain → credit the real-time purse
      log('pay', `delegation redeem ok: credited ${uusd}µUSD to ${sid} (tx ${r.ref})`);
      return json(res, 200, { ok: true, ref: r.ref, remaining: p.balance(), allowance: p.granted() });
    }
    if (req.method === 'POST' && u.pathname === '/budget/default') {
      const { cap, amount } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      if (!node.isRoot) return json(res, 403, { error: 'only the root cap may set the default allowance' });
      const amt = Math.max(0, Math.round(Number(amount) || 0));
      if (amt) defaultAllowance = amt;
      return json(res, 200, { defaultAllowance });
    }

    // ── cross-device chat sync: the chat list + transcripts, stored server-side
    //    keyed by the presenting cap. Same root link on phone + laptop → same chats. ──
    if (req.method === 'POST' && u.pathname === '/chats/load') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      try { return json(res, 200, { data: JSON.parse(await fs.promises.readFile(chatStorePath(cap), 'utf8')) }); }
      catch { return json(res, 200, { data: null }); }
    }
    // ── memo ingest: a voice memo's transcript → the entry agent processes it,
    //    capturing the trace → stored as a traceable "memo run" (field-capture posts here). ──
    if (req.method === 'POST' && u.pathname === '/memo') {
      const { transcript, title, source, cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'memo ingest requires the root cap' });
      const t = String(transcript || '').trim();
      if (!t) return json(res, 400, { error: 'empty transcript' });
      log('memo:', JSON.stringify(t).slice(0, 80));
      const persona = getPersona();
      const id = `memo-${crypto.randomBytes(5).toString('hex')}`;
      const tr = await traceRun(node, t, persona, id);
      const run = { id, title: String(title || t.slice(0, 40)) || 'voice memo', transcript: t, source: String(source || 'memo'), date: new Date().toISOString(),
        versions: [{ v: 0, label: 'original', env: { persona: persona || '' }, ...tr, at: new Date().toISOString() }] };
      const runs = await readMemoRuns(); runs.unshift(run); await writeMemoRuns(runs);
      return json(res, 200, { ok: true, id: run.id });
    }
    // re-run a memo's transcript under a CHANGED environment (persona override) → new version
    if (req.method === 'POST' && u.pathname === '/memo/rerun') {
      const { cap, id, persona, label } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const runs = await readMemoRuns(); const run = runs.find(r => r.id === String(id));
      if (!run) return json(res, 404, { error: 'no such memo run' });
      const overridePersona = typeof persona === 'string' ? persona : (run.versions[0].env.persona || getPersona() || '');
      const tr = await traceRun(node, run.transcript, overridePersona, run.id);
      const v = run.versions.length;
      run.versions.push({ v, label: String(label || `re-run ${v}`), env: { persona: overridePersona }, ...tr, at: new Date().toISOString() });
      await writeMemoRuns(runs);
      return json(res, 200, { ok: true, version: v, run });
    }
    // ── INGEST: turn an external input (a voice note's transcript) into a real,
    //    continuable chat. Runs the entry agent on the transcript with chatId set
    //    (so any push it raises deep-links back here), stores a seed-chat the SPA
    //    adopts into its chat list. This is "the voice note becomes a new chat". ──
    if (req.method === 'POST' && u.pathname === '/ingest') {
      const { transcript, title, source, cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'ingest requires the root cap' });
      const t = String(transcript || '').trim();
      if (!t) return json(res, 400, { error: 'empty transcript' });
      const id = `chat-${crypto.randomBytes(6).toString('hex')}`;
      log('ingest (propose-only):', id, JSON.stringify(t).slice(0, 80));
      // PROPOSE-ONLY: no tools, no actions — just proposed action items + the capabilities an
      // attenuated agent would need (the scoper). Then push the proposals to dan's phone.
      const { proposals, powers } = await ingestPropose(t);
      const agentMsg = proposals + (powers.length ? `\n\n— To act on this, I can spin up an attenuated agent with: ${powers.join(', ')}. Approve it from this chat.` : '');
      const tr = { answer: agentMsg, toolsUsed: [], steps: [], proposedPowers: powers };
      notify({ title: '🎙 Voice note → proposed actions', message: proposals.slice(0, 180), click: `${BASE_URL}/#chat=${id}`, tags: ['memo'] }).catch(e => log('ingest push', e.message));
      const now = new Date().toISOString();
      const seed = { id, title: (String(title || '').trim() || t.slice(0, 48)) || 'voice note', ts: Date.now(), source: String(source || 'voice'), transcript: t, proposeOnly: true, proposedPowers: powers,
        tx: [{ who: 'you', text: t }, { who: 'agent', text: agentMsg, tools: [], steps: [] }],
        versions: [{ v: 0, label: 'original', env: { persona: 'ingest:propose-only' }, ...tr, at: now }] };
      const seeds = await readSeedChats(); seeds.unshift(seed); await writeSeedChats(seeds);
      return json(res, 200, { ok: true, chatId: id, proposedPowers: powers });
    }
    if (req.method === 'POST' && u.pathname === '/seed-chats/load') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'no capability' });
      return json(res, 200, { chats: await readSeedChats() });
    }
    // re-run an ingested chat's transcript under a CHANGED environment (system-prompt
    // override) → a new version (the trace-versioning harness, for regular chats).
    if (req.method === 'POST' && u.pathname === '/chat/rerun') {
      const { cap, id, persona, label } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const seeds = await readSeedChats(); const seed = seeds.find(s => s.id === String(id));
      if (!seed) return json(res, 404, { error: 'no such chat' });
      if (!seed.versions || !seed.versions.length) { // old seed-chats (pre-versioning): synthesize v0 from tx
        const a = (seed.tx || []).find(m => m.who === 'agent') || {};
        seed.versions = [{ v: 0, label: 'original', env: { persona: '' }, answer: a.text || '', toolsUsed: a.tools || [], steps: a.steps || [], at: seed.ts ? new Date(seed.ts).toISOString() : new Date().toISOString() }];
      }
      const overridePersona = typeof persona === 'string' ? persona : (seed.versions[0].env.persona || getPersona() || '');
      const tr = await traceRun(node, seed.transcript, overridePersona, seed.id);
      const v = seed.versions.length;
      seed.versions.push({ v, label: String(label || `re-run ${v}`), env: { persona: overridePersona }, ...tr, at: new Date().toISOString() });
      await writeSeedChats(seeds);
      return json(res, 200, { ok: true, version: v, chat: seed });
    }
    if (req.method === 'POST' && u.pathname === '/memos/load') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'no capability' });
      return json(res, 200, { runs: await readMemoRuns() });
    }
    // delete a voice-memo run (memos are first-class conversations — deletable like any chat)
    if (req.method === 'POST' && u.pathname === '/memos/delete') {
      const { cap, id } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const runs = await readMemoRuns(); const next = runs.filter(r => r.id !== String(id));
      await writeMemoRuns(next);
      return json(res, 200, { ok: true, removed: runs.length - next.length });
    }
    // ── ASKS (the inline feedback loop): structured, TYPED, answerable notifications.
    //    Raised by the entry agent (askOperator) or off-app agents (asks.mjs). dan
    //    answers inline with type-appropriate controls; chat-origin asks continue the
    //    chat, off-app asks are flushed to the input-runner drain on a single "Done". ──
    // dev (Blacksmith) visibility: the tasks routed from a chat + their status/result,
    // so the dev agent is not opaque. Merges task + later completion lines by id.
    if (req.method === 'POST' && u.pathname === '/dev/updates') {
      const { cap, chatId } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      let lines = []; try { lines = (await fs.promises.readFile(DEV_QUEUE_FILE, 'utf8')).split('\n').filter(Boolean); } catch {}
      const byId = new Map();
      for (const ln of lines) { try { const o = JSON.parse(ln); byId.set(o.id, { ...(byId.get(o.id) || {}), ...o }); } catch {} }
      const all = [...byId.values()];
      // top-level tasks for this chat; each carries its reply THREAD (operator follow-ups
      // + the dev's responses) so you can dip into the thread without leaving the chat.
      const top = all.filter(t => !t.replyTo).filter(t => (chatId ? t.chatId === String(chatId) : true)).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      for (const t of top) {
        const reps = all.filter(r => r.replyTo === t.id).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
        t.thread = [];
        for (const r of reps) { t.thread.push({ role: 'you', text: r.task, at: r.at }); if (r.result) t.thread.push({ role: 'dev', text: r.result, at: r.finishedAt || r.at }); }
      }
      return json(res, 200, { tasks: top });
    }
    // reply IN a dev thread — routes ONLY to that dev task (replyTo), never into the
    // top-level chat history. The dev picks it up as a follow-up on the same work.
    if (req.method === 'POST' && u.pathname === '/thread/reply') {
      const { cap, parent, chatId, text } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const t = String(text || '').trim(); if (!t) return json(res, 400, { error: 'empty' });
      let to = 'blacksmith';
      try { for (const ln of (await fs.promises.readFile(DEV_QUEUE_FILE, 'utf8')).split('\n').filter(Boolean)) { try { const o = JSON.parse(ln); if (o.id === String(parent) && o.to) to = o.to; } catch {} } } catch {}
      await fs.promises.mkdir(path.dirname(DEV_QUEUE_FILE), { recursive: true });
      await fs.promises.appendFile(DEV_QUEUE_FILE, `${JSON.stringify({ id: `rep-${crypto.randomBytes(5).toString('hex')}`, to, task: t, replyTo: String(parent), thread: String(parent), status: 'pending', at: new Date().toISOString(), chatId: String(chatId || '') })}\n`);
      return json(res, 200, { ok: true });
    }
    // available model-providers for the per-chat model picker (local tinix models).
    if (req.method === 'POST' && u.pathname === '/models') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      const models = [{ id: 'default', label: 'Gemma (local · default)' }];
      try {
        const r = await fetch((process.env.AGENT_LLM || 'http://192.168.50.226:8003/v1/chat/completions').replace('/chat/completions', '/models'), { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        for (const id of (j.data || []).map(m => m.id).filter(Boolean)) if (id !== 'default') models.push({ id, label: `${id} (local)` });
      } catch {}
      return json(res, 200, { models });
    }
    if (req.method === 'POST' && u.pathname === '/asks/load') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'asks require the root cap' });
      const asks = readAsks();
      const open = asks.filter(a => a.status === 'open');
      const answeredOffApp = asks.filter(a => a.status === 'answered' && a.origin && a.origin.kind !== 'chat'); // staged, awaiting flush
      return json(res, 200, { asks: open, answeredPending: answeredOffApp, openCount: open.length, pendingFlush: answeredOffApp.length });
    }
    if (req.method === 'POST' && u.pathname === '/asks/answer') {
      const { cap, id, answers } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const ask = answerAsk(id, answers || {});
      if (!ask) return json(res, 404, { error: 'no such ask' });
      log('ask answered:', ask.id, ask.origin && ask.origin.kind);
      return json(res, 200, { ok: true, ask });
    }
    // "Done — process my answers": flush every ANSWERED off-app ask into the input-runner
    // drain (one claude -p run picks up all of them), and mark them done.
    if (req.method === 'POST' && u.pathname === '/asks/flush') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const asks = readAsks();
      const pend = asks.filter(a => a.status === 'answered' && a.origin && a.origin.kind !== 'chat');
      for (const a of pend) {
        const prompt = `The operator answered your earlier questions on "${a.title}":\n\n${formatAnswers(a)}\n\nProceed accordingly (requested by ${a.requestedBy || 'an agent'}).`;
        try { enqueueReply({ doc: (a.origin && a.origin.doc) || '', label: a.title, title: a.title, prompt }); setAskStatus(a.id, 'done'); }
        catch (e) { log('flush enqueue failed', a.id, e.message); }
      }
      return json(res, 200, { ok: true, flushed: pend.length });
    }
    // ── notification inbox (🔔): read the shared feed (data endowment) + per-cap
    //    dismissed-state. Agents post via the `notify`/`pushFeed` powers → feed.json. ──
    if (req.method === 'POST' && u.pathname === '/feed/load') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      let entries = []; try { entries = (JSON.parse(await fs.promises.readFile(FEED_FILE, 'utf8')).entries) || []; } catch {}
      let dismissed = []; try { dismissed = (JSON.parse(await fs.promises.readFile(notifStorePath(cap), 'utf8')).dismissed) || []; } catch {}
      const ds = new Set(dismissed);
      const items = entries.slice(0, 80).map(e => ({
        id: e.id, date: e.date, agent: e.agent || '', avatar: e.avatar || '', title: e.title,
        body: String(e.body || '').slice(0, 400), status: e.status || '', note: e.note || '', links: (e.links || []).map(feedLinkHref),
        attention: ATTENTION_RE.test(String(e.status || '')) || e.kind === 'notification', dismissed: ds.has(e.id),
      }));
      return json(res, 200, { items, attentionCount: items.filter(i => i.attention && !i.dismissed).length });
    }
    if (req.method === 'POST' && u.pathname === '/feed/dismiss') {
      const { cap, id } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      try {
        await fs.promises.mkdir(NOTIF_DIR, { recursive: true });
        let dismissed = []; try { dismissed = (JSON.parse(await fs.promises.readFile(notifStorePath(cap), 'utf8')).dismissed) || []; } catch {}
        if (!dismissed.includes(String(id))) dismissed.push(String(id));
        await fs.promises.writeFile(notifStorePath(cap), JSON.stringify({ dismissed: dismissed.slice(-500) }));
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (req.method === 'POST' && u.pathname === '/chats/save') {
      const { cap, data } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      try {
        const s = JSON.stringify(data || {});
        if (s.length > 6 * 1024 * 1024) return json(res, 413, { error: 'too large' });
        await fs.promises.mkdir(CHATS_DIR, { recursive: true });
        await withChatLock(cap, () => fs.promises.writeFile(chatStorePath(cap), s)); // serialize vs the agent's retitle
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // ── confirm / reject a proposed destructive action. The agent can only
    //    PROPOSE; a human deliberately confirms before anything fires. Confirmation
    //    is MANDATORY for every destructive action — including ones reached through
    //    a SHARED cap (a mistranscribed "unlock the door" must never auto-fire).
    //    Authority to confirm = HOLDING THE POWER the proposal belongs to. So the
    //    operator (root holds all) confirms the agent's proposals, and a holder of
    //    a destructive share SELF-CONFIRMS their own (the typo/mishearing guard). ──
    if (req.method === 'POST' && (u.pathname === '/confirm' || u.pathname === '/reject')) {
      const { cap, id, dontAskAgain } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { ok: false, error: 'no capability' });
      const prop = getProposal(id);
      if (!prop) return json(res, 404, { ok: false, error: 'unknown proposal' });
      if (!node.isRoot && !node.powers.has(prop.power)) return json(res, 403, { ok: false, error: `you don't hold the authority (${prop.power}) to confirm this action` });
      // "don't ask again" records a (creating-agent, kind) auto-confirm rule on commit
      const out = u.pathname === '/confirm' ? await commitProposal(id, { rememberKind: !!dontAskAgain }) : rejectProposal(id);
      return json(res, 200, out);
    }
    // ── SCOPING (Feature A): propose the minimal powers a prompt needs, then mint a confined
    //    per-chat cap from the approved set. Root-gated (only the full cap may mint a child). ──
    if (req.method === 'POST' && u.pathname === '/scope') {
      const { cap, prompt, sessionId } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'scoping needs your root capability' });
      const sid = String(sessionId || '').slice(0, 64); // stream the scoper's private round-trips to this chat's pendant
      const { proposed, by } = await scopePowers(String(prompt || ''), sid ? ev => emitStep(sid, ev) : null);
      if (sid) emitStep(sid, { t: 'end' });
      // Fast-path: a TRIVIAL read needs no consent click. If the proposed set is small and entirely
      // READ-SAFE (powers whose only effects are reads, or destructive verbs that still propose→confirm),
      // tell the client to auto-approve + run. The granted powers still show at the top of the chat
      // (and root can re-scope), so it stays auditable — we just skip the modal for "is the door open?".
      const READ_SAFE = new Set(['homeassistant', 'notes', 'reference', 'research', 'web', 'youtube', 'app']);
      const autoApprove = proposed.length > 0 && proposed.length <= 2 && proposed.every(p => READ_SAFE.has(p));
      return json(res, 200, { proposed, by, catalog: POWER_CATALOG, autoApprove });
    }
    // ntfy phone-setup info for the notifications tab (root-gated — the topic is dan's push channel).
    if (req.method === 'POST' && u.pathname === '/notify/info') {
      if (!nodeFor((await jsonBody(req)).cap)?.isRoot) return json(res, 403, { error: 'no capability' });
      let cfg = {}; try { cfg = JSON.parse(await fs.promises.readFile(`${HOME}/.config/field-notify/config.json`, 'utf8')); } catch {}
      return json(res, 200, { server: cfg.server || '', topic: cfg.topic || '' });
    }
    // ── SKILL descriptor (self-describing endowment): any cap (or a share token) → its EXACT powers
    //    + the callable method catalog + the wire to call them. A generic agent that fetches this has
    //    everything it needs to USE the endowment headlessly — the page need not be human-rendered. ──
    if (req.method === 'POST' && u.pathname === '/skill') {
      const body = await jsonBody(req);
      let node = nodeFor(body.cap);
      if (!node && body.token) { try { const rec = JSON.parse(await fs.promises.readFile(path.join(SHARED_DIR, `${String(body.token).replace(/[^0-9a-f]/g, '')}.json`), 'utf8')); node = nodeFor(rec.scopedCap); } catch {} }
      if (!node) return json(res, 404, { error: 'unknown capability or share' });
      const { manifest } = node.toolbox({ chatId: 'skill' });
      return json(res, 200, {
        kind: node.isRoot ? 'root' : 'scoped',
        powers: node.isRoot ? ALL_POWERS : [...node.powers],
        methods: manifest, // [{name, args, description}] — the callable catalog this endowment grants
        wire: {
          talk: 'POST {origin}/chat {cap, text, attachments?} — converse + invoke methods (cap = hex after #cap=)',
          share: 'POST {origin}/share/post {token, text} — if you hold a #chatshare write link (token = hex after #chatshare=)',
          delegate: 'POST {origin}/rpc {swissnum, method:"share", args:[power,name]} — mint an attenuated sub-cap',
          subChat: 'POST {origin}/subchat {cap, powers:[…], title} — mint a child chat with a SUBSET of your powers (monotonic)',
          introspect: 'POST {origin}/skill {cap | token} — re-read this descriptor',
        },
      });
    }
    // ── Right to Create an Attenuated Agent Chat: any cap may mint a CHILD chat-cap holding a SUBSET
    //    of the powers IT holds (monotonic delegation — you can't grant what you don't hold). The
    //    minted sub-chat is immediately usable + shareable (Feature B). ──
    if (req.method === 'POST' && u.pathname === '/subchat') {
      const { cap, powers, title } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      const held = node.isRoot ? ALL_POWERS : [...node.powers]; // monotonic: subset of what the caller holds
      const granted = (Array.isArray(powers) ? powers : []).filter(p => held.includes(p));
      const out = mintScopedCap({ powers: granted, label: title || 'subchat' });
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers });
    }
    if (req.method === 'POST' && u.pathname === '/scope/mint') {
      const { cap, powers, label } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'minting a scoped cap needs your root capability' });
      const out = mintScopedCap({ powers: Array.isArray(powers) ? powers : [], label });
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers });
    }
    // INVITE a new user (Phase 1): mint a persisted, confined starter cap. Default ring = least-privilege
    // stateless/read-only tools + the `contact` back-channel; the invitee can `requestAccess` for more.
    if (req.method === 'POST' && u.pathname === '/invite') {
      const { cap, powers, label } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'inviting needs your root capability' });
      const STARTER = STARTER_RING; // least-privilege starter ring (single source: system-map.mjs)
      const ring = (Array.isArray(powers) && powers.length) ? powers.filter(p => ALL_POWERS.includes(p)) : STARTER;
      const out = mintScopedCap({ powers: ring, label: label || 'guest' });
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, starter: STARTER });
    }
    // CONNECTORS (Phase 3 Lane A): the owner wires up an API-service tool. The secret value is stored
    // in the named vault (never echoed back / never in the connector record) and injected at call time.
    if (req.method === 'POST' && u.pathname.startsWith('/connectors')) {
      const body = await jsonBody(req);
      if (!nodeFor(body.cap)?.isRoot) return json(res, 403, { error: 'managing connectors needs your root capability' });
      if (u.pathname === '/connectors/list') return json(res, 200, { connectors: connectors.list() });
      if (u.pathname === '/connectors/add') {
        const secretName = String(body.secretName || '').replace(/[^\w.-]/g, '_').slice(0, 60);
        if (secretName && typeof body.secret === 'string' && body.secret.trim()) storeNamedSecret(secretName, body.secret.trim()); // → vault; not echoed
        const r = connectors.add({ name: body.name, baseUrl: body.baseUrl, header: body.header, valueTemplate: body.valueTemplate, secretName, readOnly: body.readOnly, description: body.description, costUusd: body.costUusd, commissionPct: body.commissionPct, resale: body.resale });
        return json(res, 200, r);
      }
      if (u.pathname === '/connectors/remove') return json(res, 200, connectors.remove(String(body.id || '')));
      return json(res, 404, { error: 'unknown connectors route' });
    }
    // CUSTOM TOOLS (agent-proposed code tools): owner reviews the code + admits/rejects. Admitting is the
    // ── CONSUMING a shared component (token-gated; the token IS the access, no root needed). Charged
    //    the standard way: the consumer's own purse is debited, the sharer is credited. ─────────────
    if (req.method === 'POST' && u.pathname.startsWith('/tools/shared/')) {
      const body = await jsonBody(req);
      const token = String(body.token || '');
      const desc = toolShares.describe(token);
      if (u.pathname === '/tools/shared/describe') return desc ? json(res, 200, { ok: true, ...desc }) : json(res, 404, { ok: false, error: 'unknown or revoked share' });
      if (!desc) return json(res, 404, { ok: false, error: 'unknown or revoked share' });
      const sid = String(body.sessionId || '').slice(0, 64);
      // standard enforcement: debit the consumer's allowance purse by the price; credit the sharer.
      const charge = () => {
        if (!desc.priceUsd) return { ok: true, remaining: null };
        if (!nodeFor(body.cap)) return { ok: false, error: 'this is a PAID share — open it with your capability so your allowance can be charged' };
        const purse = purseFor(body.cap, sid);
        if (!purse.canAfford(desc.priceUsd)) return { ok: false, exhausted: true, price: desc.priceUsd, remaining: purse.balance() };
        purse.debit(desc.priceUsd); toolShares.credit(desc.sharer, desc.priceUsd);
        return { ok: true, remaining: purse.balance() };
      };
      if (u.pathname === '/tools/shared/call') { // INSTANCE: invoke the sharer's hosted instance, attenuated + metered + paid-per-use
        if (desc.mode !== 'instance') return json(res, 400, { ok: false, error: 'this is a factory share — use /tools/shared/import' });
        const method = body.method ? String(body.method) : undefined;
        const gate = toolShares.check(token, method); if (!gate.ok) return json(res, 200, { ok: false, error: gate.error });
        const pay = charge(); if (!pay.ok) return json(res, 200, pay);
        toolShares.count(token);
        const r = await customTools.call(gate.rec.toolId, { method, args: body.args || {} });
        return json(res, 200, { ...r, remaining: pay.remaining });
      }
      if (u.pathname === '/tools/shared/import') { // FACTORY: pay-once, get the class bundle → host your OWN instance (enters review)
        if (desc.mode !== 'factory') return json(res, 400, { ok: false, error: 'this is an instance share — use /tools/shared/call' });
        const gate = toolShares.check(token); if (!gate.ok) return json(res, 200, { ok: false, error: gate.error });
        const exported = await customTools.exportClass(gate.rec.toolId); if (!exported.ok) return json(res, 200, exported);
        const pay = charge(); if (!pay.ok) return json(res, 200, pay);
        toolShares.count(token);
        return json(res, 200, { ok: true, bundle: exported.bundle, remaining: pay.remaining, note: 'POST this bundle to /tools/import to host your own instance (it enters review).' });
      }
      if (u.pathname === '/tools/shared/git') { // GIT: the component shared AS its EndoGit object (read, or read-write collaborator)
        if (desc.mode !== 'git') return json(res, 400, { ok: false, error: `this is a ${desc.mode} share, not a git share` });
        const id = desc.toolId; const op = String(body.op || 'history'); const ref = String(body.ref || 'HEAD');
        const gate = toolShares.check(token); if (!gate.ok) return json(res, 200, { ok: false, error: gate.error });
        const pay = charge(); if (!pay.ok) return json(res, 200, pay);
        toolShares.count(token);
        // READ ops (any git share) read the immutable git tree as a folder/file-object.
        if (op === 'history') return json(res, 200, { ok: true, access: desc.access, versions: await componentGit.history(id), remaining: pay.remaining });
        if (op === 'files') { const s = await componentGit.readAt(id, ref); return json(res, 200, s ? { ok: true, files: Object.keys(s.files), remaining: pay.remaining } : { ok: false, error: 'unknown version' }); }
        if (op === 'read') { const s = await componentGit.readAt(id, ref); if (!s) return json(res, 200, { ok: false, error: 'unknown version' }); const c = s.files[String(body.path || '')]; return json(res, 200, c === undefined ? { ok: false, error: `no file "${body.path}"` } : { ok: true, path: String(body.path), content: c, remaining: pay.remaining }); }
        // WRITE op needs a read-WRITE git share. A collaborator's write commits a NEW VERSION (the owner
        // reviews/promotes it from the Components tab) — it does NOT auto-replace the sharer's live tool.
        if (op === 'write') {
          if (desc.access !== 'write') return json(res, 200, { ok: false, error: 'this is a READ-ONLY git share — you cannot write' });
          if (!String(body.path || '').trim()) return json(res, 200, { ok: false, error: 'name the file path to write' });
          let r; try { r = await componentGit.writeFile(id, String(body.path), String(body.content ?? ''), String(body.message || `collab edit ${body.path}`)); } catch (e) { return json(res, 200, { ok: false, error: `write failed: ${(e && e.message) || e}` }); }
          return json(res, 200, { ok: true, version: String(r.version).slice(0, 12), remaining: pay.remaining, note: 'Committed a new version on the component (the owner reviews/promotes it in the Components tab).' });
        }
        return json(res, 200, { ok: false, error: `unknown git op "${op}" (history | files | read | write)` });
      }
      return json(res, 404, { ok: false, error: 'unknown shared-tool route' });
    }

    // ONLY way a proposed tool becomes callable — never auto-injected. (Also the root-gated component
    // version ops, /components/* — review/admit/share/version all need the owner's root cap.)
    if (req.method === 'POST' && (u.pathname.startsWith('/tools') || u.pathname.startsWith('/components/'))) {
      const body = await jsonBody(req);
      if (!nodeFor(body.cap)?.isRoot) return json(res, 403, { error: 'managing tools/components needs your root capability' });
      if (u.pathname === '/tools/review') {
        // Run the discipline-review PANEL (ocap / propagator / cap-hygiene / sharing) over each pending
        // tool that hasn't been reviewed yet, cache the findings on the record, and return them with the
        // code — so the human (social-collateral) admission gate decides INFORMED by every discipline.
        const all = customTools.listAll();
        const todo = all.filter(t => t.status === 'pending' && (!t.review || body.force));
        if (todo.length) {
          await Promise.all(todo.map(async t => {
            try { const review = await runReviewPanel(t, { callLLM, ranAt: new Date().toISOString() }); customTools.setReview(t.id, review); } catch (e) { log('review-panel', e.message); }
          }));
        }
        return json(res, 200, { tools: customTools.listAll() });
      }
      if (u.pathname === '/tools/admit') {
        // Critical findings from the panel require a deliberate override — the human stays the gate, but
        // admitting a Critically-flagged tool is an explicit act, not an accident.
        const t = customTools.listAll().find(x => x.id === String(body.id || ''));
        if (t && t.review && t.review.worst === 'critical' && !body.override) {
          return json(res, 200, { ok: false, blocked: 'critical', worst: t.review.worst, findings: t.review.findings, note: 'The review panel flagged a CRITICAL issue. Re-submit admit with override:true to admit anyway (deliberate act), or reject/fix it.' });
        }
        const r = customTools.admit(String(body.id || ''));
        // On admit, commit the component's SOURCE as a version into its git-as-Endo object (the start
        // of its lineage; later edits add versions, enabling fork + revert).
        if (r.ok && t) { try { await componentGit.commit(t.id, sourceFilesOf(t), `admit: ${t.name}`); } catch (e) { log('component-git admit', e.message); } }
        return json(res, 200, r);
      }
      if (u.pathname === '/tools/reject') return json(res, 200, customTools.reject(String(body.id || '')));
      if (u.pathname === '/tools/pending-count') return json(res, 200, { count: customTools.listAll().filter(t => t.status === 'pending').length }); // cheap (no panel) — for the tab badge
      // COMPONENT = git-as-Endo object: version history / read-at-version / non-destructive revert.
      // ISLAND components (confined-Preact UI, id "island-…") route to islandSource (rewrite client file + rebuild).
      if (u.pathname === '/components/islands') return json(res, 200, { ok: true, islands: islandSource.list() });
      if (u.pathname === '/components/history') { const id = String(body.id || ''); return islandSource.isIsland(id) ? json(res, 200, { ok: true, versions: await islandSource.history(id) }) : json(res, 200, { ok: true, versions: await componentGit.history(id), grains: customTools.grainData(id) }); }
      if (u.pathname === '/components/read') { const id = String(body.id || ''); const s = await (islandSource.isIsland(id) ? islandSource.readAt(id, String(body.version || 'HEAD')) : componentGit.readAt(id, String(body.version || 'HEAD'))); return json(res, 200, s ? { ok: true, ...s } : { ok: false, error: 'unknown component/version' }); }
      if (u.pathname === '/components/fork') { const id = String(body.id || ''); if (islandSource.isIsland(id)) return json(res, 200, { ok: false, error: 'forking an island component isn\'t supported yet — edit or revert it' }); return json(res, 200, await forkComponentTo(customTools, id, String(body.name || ''), String(body.version || 'HEAD'), 'owner')); }
      if (u.pathname === '/components/edit') { const id = String(body.id || ''); return json(res, 200, islandSource.isIsland(id) ? await editIslandSource(id, String(body.prompt || '')) : await editComponentSource(customTools, id, String(body.prompt || ''))); }
      if (u.pathname === '/components/revert') {
        const id = String(body.id || ''); const version = String(body.version || '');
        if (islandSource.isIsland(id)) return json(res, 200, await islandSource.revert(id, version));
        const snap = await componentGit.readAt(id, version); if (!snap) return json(res, 200, { ok: false, error: 'unknown component/version' });
        const rv = await componentGit.revert(id, version); // new commit restoring the old tree (history kept)
        const upd = customTools.setSource(id, snap.files); // point the LIVE tool at the reverted source + drop its cached instance
        return json(res, 200, { ok: upd.ok !== false, version: rv.version, note: 'Reverted the component to the chosen version (a new version; history preserved). The live tool now runs the reverted source.' });
      }
      // SHARE a tool — as a factory (others host their own) or an attenuated, metered, priced instance.
      if (u.pathname === '/tools/share') {
        const tool = customTools.listAll().find(t => t.id === String(body.id || '') || t.name === String(body.id || ''));
        if (!tool) return json(res, 200, { ok: false, error: 'no such tool' });
        if (tool.status !== 'admitted') return json(res, 200, { ok: false, error: 'only an admitted tool can be shared' });
        const rec = toolShares.create({ toolId: tool.id, toolName: tool.name, mode: body.mode, access: body.access, methods: body.methods, ratePerMin: body.ratePerMin, quota: body.quota, ttlMs: body.ttlMs, priceUsd: body.priceUsd, sharer: String(body.sharer || 'owner'), now: new Date().toISOString() });
        const verb = rec.mode === 'factory' ? 'import' : rec.mode === 'git' ? 'git' : 'call';
        return json(res, 200, { ok: true, token: rec.token, mode: rec.mode, access: rec.access, priceUsd: rec.priceUsd, attenuation: rec.attenuation, url: `${BASE_URL}/tools/shared/${verb}#token=${rec.token}` });
      }
      if (u.pathname === '/tools/share/revoke') return json(res, 200, toolShares.revoke(String(body.token || '')));
      if (u.pathname === '/tools/shares') return json(res, 200, { shares: toolShares.list(), earnings: toolShares.earnings(String(body.sharer || 'owner')) });
      if (u.pathname === '/tools/export') return json(res, 200, await customTools.exportClass(String(body.id || ''))); // a CLASS as a shareable, real multi-module Endo bundle
      if (u.pathname === '/tools/import') return json(res, 200, customTools.importClass({ bundle: body.bundle, proposedBy: 'import', now: new Date().toISOString() })); // someone else's class → PENDING review
      return json(res, 404, { error: 'unknown tools route' });
    }
    // Re-grant / revoke a chat's powers in place (the banner "+ Add" / "×"). Root-only. If the chat's
    // cap is orphaned (minted before persistence), mint a FRESH one so the chat recovers — returns the
    // cap to use (same swiss when re-scoped, a new swiss when recovered).
    if (req.method === 'POST' && u.pathname === '/chat/rescope') {
      const { cap, swiss, powers, label } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'changing a chat\'s powers needs your root capability' });
      const want = Array.isArray(powers) ? powers : [];
      const rc = rescopeCap(String(swiss || ''), want);
      if (rc.ok) return json(res, 200, { scopedCap: rc.swiss, powers: rc.powers, recovered: false });
      const out = mintScopedCap({ powers: want, label: label || 'chat' }); // orphaned/unknown → recover with a fresh live cap
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, recovered: true });
    }

    // ── SHARE A CHAT (Feature B): the owner mints a link to a chat; anyone with the link (even a
    //    brand-new user, no account) gets it in their bar + can read; a WRITE link lets them append
    //    and resume — the agent runs under the chat's CONFINED cap (so a write-share delegates exactly
    //    the chat's approved powers, never more), metered against an optional recipient allowance. ──
    if (req.method === 'POST' && u.pathname === '/share/create') {
      const { cap, chatId, title, tx, scopedCap, mode, allowanceUsd, name } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'sharing needs your root capability' });
      const token = crypto.randomBytes(16).toString('hex');
      const rec = {
        token, name: String(name || '').slice(0, 80), chatId: String(chatId || ''), title: String(title || 'Shared chat').slice(0, 120),
        tx: Array.isArray(tx) ? tx.slice(-200) : [], scopedCap: nodeFor(scopedCap) ? scopedCap : cap, // the chat's confined cap drives a write-share
        mode: mode === 'write' ? 'write' : 'read', allowanceUsd: Math.max(0, Number(allowanceUsd) || 0), createdAt: new Date().toISOString(),
      };
      await fs.promises.mkdir(SHARED_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(SHARED_DIR, `${token}.json`), JSON.stringify(rec, null, 2));
      if (rec.allowanceUsd > 0) fundSharePurse(token, Math.round(rec.allowanceUsd * 1e6)); // µUSD (durable)
      return json(res, 200, { token, name: rec.name, mode: rec.mode, allowanceUsd: rec.allowanceUsd });
    }
    // list the named share links the owner created for a chat (root only; tx/scopedCap NOT exposed).
    if (req.method === 'POST' && u.pathname === '/share/list') {
      const { cap, chatId } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'listing shares needs your root capability' });
      let files = []; try { files = await fs.promises.readdir(SHARED_DIR); } catch { /* none yet */ }
      const shares = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        let rec; try { rec = JSON.parse(await fs.promises.readFile(path.join(SHARED_DIR, f), 'utf8')); } catch { continue; }
        if (chatId && rec.chatId !== String(chatId)) continue;
        shares.push({ token: rec.token, name: rec.name || '', mode: rec.mode, allowanceUsd: rec.allowanceUsd || 0, createdAt: rec.createdAt, title: rec.title });
      }
      shares.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json(res, 200, { shares });
    }
    // adjust an existing share's permissions (mode / allowance / name) — root only.
    if (req.method === 'POST' && u.pathname === '/share/update') {
      const { cap, token, mode, allowanceUsd, name } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'adjusting a share needs your root capability' });
      const tok = String(token || '').replace(/[^0-9a-f]/g, '');
      let rec; try { rec = JSON.parse(await fs.promises.readFile(path.join(SHARED_DIR, `${tok}.json`), 'utf8')); } catch { return json(res, 404, { error: 'unknown share' }); }
      if (mode !== undefined) rec.mode = mode === 'write' ? 'write' : 'read';
      if (name !== undefined) rec.name = String(name || '').slice(0, 80);
      if (allowanceUsd !== undefined) {
        rec.allowanceUsd = Math.max(0, Number(allowanceUsd) || 0);
        if (rec.allowanceUsd > 0) fundSharePurse(tok, Math.round(rec.allowanceUsd * 1e6)); else unfundSharePurse(tok);
      }
      await fs.promises.writeFile(path.join(SHARED_DIR, `${tok}.json`), JSON.stringify(rec, null, 2));
      return json(res, 200, { token: tok, name: rec.name, mode: rec.mode, allowanceUsd: rec.allowanceUsd });
    }
    // revoke a share link entirely (deletes the record; the link dies) — root only.
    if (req.method === 'POST' && u.pathname === '/share/revoke') {
      const { cap, token } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'revoking a share needs your root capability' });
      const tok = String(token || '').replace(/[^0-9a-f]/g, '');
      try { await fs.promises.unlink(path.join(SHARED_DIR, `${tok}.json`)); } catch { /* already gone */ }
      unfundSharePurse(tok);
      return json(res, 200, { revoked: true });
    }
    if (req.method === 'POST' && u.pathname === '/share/open') {
      const { token, since } = await jsonBody(req); // NO cap — the unguessable token IS the access (Waterken-style)
      let rec; try { rec = JSON.parse(await fs.promises.readFile(path.join(SHARED_DIR, `${String(token || '').replace(/[^0-9a-f]/g, '')}.json`), 'utf8')); } catch { return json(res, 404, { error: 'unknown or revoked share' }); }
      const len = (rec.tx || []).length;
      // LIVE ROOM: a `since` cursor makes this a cheap poll — return only turns appended since the
      // caller last saw. Anyone holding the link (owner included) polls + posts the SAME rec.tx, so the
      // chat is one canonical room (pass-by-reference), not a divergent copy.
      if (Number.isInteger(since) && since >= 0) return json(res, 200, { tx: (rec.tx || []).slice(since), len, mode: rec.mode });
      // self-describing: a recipient agent gets the chat's ENDOWMENT (powers + callable methods) +
      // how to drive it — so a generic agent effectively gains the skill to use it, not just read it.
      const node = nodeFor(rec.scopedCap); let powers = [], methods = [];
      if (node) { powers = node.isRoot ? ALL_POWERS : [...node.powers]; try { methods = node.toolbox({ chatId: 'share' }).manifest; } catch {} }
      return json(res, 200, { chatId: rec.chatId, title: rec.title, tx: rec.tx, len, mode: rec.mode, hasAllowance: !!sharePurseFor(rec.token),
        endowment: { powers, methods, write: rec.mode === 'write' ? `POST {origin}/share/post {token:"${rec.token}", text} to drive the agent (it runs with these powers)` : 'read-only — no /share/post' } });
    }
    if (req.method === 'POST' && u.pathname === '/share/post') {
      const { token, text } = await jsonBody(req);
      const tok = String(token || '').replace(/[^0-9a-f]/g, '');
      let rec; try { rec = JSON.parse(await fs.promises.readFile(path.join(SHARED_DIR, `${tok}.json`), 'utf8')); } catch { return json(res, 404, { error: 'unknown or revoked share' }); }
      if (rec.mode !== 'write') return json(res, 403, { error: 'this is a read-only share' });
      const node = nodeFor(rec.scopedCap);
      if (!node) return json(res, 410, { error: 'the shared chat\'s capability was revoked' });
      const t = String(text || '').trim(); if (!t) return json(res, 400, { error: 'empty' });
      const purse = sharePurseFor(tok); // allowance purse (if the owner funded one) — bounds the recipient's spend (durable across restarts)
      const perProvider = {};
      const llm = purse ? makeMeteredLLM({ callLLM, purse, perProvider }) : undefined;
      const { toolbox, manifest } = node.toolbox({ chatId: `share-${tok.slice(0, 8)}` });
      const history = (rec.tx || []).filter(m => m && m.text).map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: String(m.text) })).slice(-24);
      // mirror /chat: extract any generated image so the RECIPIENT sees it (images, live render) AND it
      // survives a reload (imageUrls = durable /uploads copies, stored in the share tx).
      const images = [], imageUrls = [];
      const r = await AGENT_RUNNER({ toolbox, manifest, userText: t, history, persona: getPersona(), model: 'default', llm,
        onStep: s => {
          if (s.kind !== 'tool' || !s.result) return;
          if (s.result.savedTo && String(s.result.savedTo).endsWith('.png')) {
            try { images.push('data:image/png;base64,' + fs.readFileSync(s.result.savedTo).toString('base64')); } catch {}
            try { const fname = `${crypto.randomBytes(16).toString('hex')}.png`; fs.copyFileSync(s.result.savedTo, path.join(UPLOADS, fname)); imageUrls.push(`/uploads/${fname}`); } catch (e) { log('share imgcopy', e.message); }
          }
        },
      });
      if (r.exhausted) return json(res, 200, { exhausted: true, remaining: purse ? purse.balance() : 0 });
      rec.tx.push({ who: 'you', text: t }, { who: 'agent', text: r.answer || '', tools: (r.toolsUsed || []).map(x => x.name || x), imageUrls });
      rec.tx = rec.tx.slice(-200);
      await fs.promises.writeFile(path.join(SHARED_DIR, `${tok}.json`), JSON.stringify(rec, null, 2));
      return json(res, 200, { answer: r.answer, images, imageUrls, toolsUsed: (r.toolsUsed || []).map(x => x.name || x), len: rec.tx.length, remaining: purse ? purse.balance() : null });
    }

    // ── PROJECTS: a folder grouping chats + scheduled agents, sharing one home folder.
    //    The surface for "recurring self-improvement from within the chat projects interface".
    //    Root-gated: projects are dan's automation (a shared/sub cap must not manage them). ──
    if (req.method === 'POST' && u.pathname.startsWith('/projects')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'projects need your root capability' });
      try {
        if (u.pathname === '/projects/list') return json(res, 200, { projects: projects.listProjects(), powers: ALL_POWERS });
        if (u.pathname === '/projects/create') return json(res, 200, { project: projects.createProject(body.name) });
        if (u.pathname === '/projects/rename') return json(res, 200, { project: projects.renameProject(body.id, body.name) });
        if (u.pathname === '/projects/attach') return json(res, 200, { project: projects.attachChat(body.id, body.chatId) });
        if (u.pathname === '/projects/detach') return json(res, 200, { project: projects.detachChat(body.id, body.chatId) });
        if (u.pathname === '/projects/agents/add') {
          const agent = projects.addScheduledAgent(body.id, { name: body.name, prompt: body.prompt, tools: body.tools, schedule: body.schedule, model: body.model });
          projects.updateScheduledAgent(body.id, agent.id, { nextAt: projects.computeNextAt(agent.schedule, Date.now()) });
          return json(res, 200, { agent: projects.listScheduledAgents(body.id).find(a => a.id === agent.id) });
        }
        if (u.pathname === '/projects/agents/update') return json(res, 200, { agent: projects.updateScheduledAgent(body.id, body.agentId, body.patch || {}) });
        if (u.pathname === '/projects/agents/remove') { projects.removeScheduledAgent(body.id, body.agentId); return json(res, 200, { ok: true }); }
        if (u.pathname === '/projects/agents/run') {
          const project = projects.getProject(body.id); const agent = projects.listScheduledAgents(body.id).find(a => a.id === body.agentId);
          if (!project || !agent) return json(res, 404, { error: 'no such project/agent' });
          const out = await runProjectAgent(project, agent);
          return json(res, 200, { ok: out.ok !== false, answer: out.answer || out.error || '', toolsUsed: out.toolsUsed || [], proposals: (out.proposalIds || []).length });
        }
        // ── PROJECT HOME FOLDER: list/download/upload files in the project's shared home dir.
        //    Binary-safe (base64) so any file type round-trips; path-guarded inside the root;
        //    uploads size-bounded. Same root-cap gate as the rest of /projects. ──
        if (u.pathname.startsWith('/projects/files')) {
          const project = projects.getProject(body.id);
          if (!project) return json(res, 404, { error: 'no such project' });
          const root = path.join(HOME_BASE, project.homeSubkey);
          const safe = name => { // resolve a requested name inside root or throw
            const pth = path.resolve(root, String(name || '').replace(/^\/+/, ''));
            if (pth !== root && !pth.startsWith(root + path.sep)) throw new Error('path escapes the project folder');
            return pth;
          };
          if (u.pathname === '/projects/files/list') {
            let entries = [];
            try {
              entries = fs.readdirSync(root, { withFileTypes: true })
                .filter(e => e.isFile())
                .map(e => { let size = 0, mtime = 0; try { const st = fs.statSync(path.join(root, e.name)); size = st.size; mtime = st.mtimeMs; } catch {} return { name: e.name, size, mtime }; })
                .sort((a, b) => b.mtime - a.mtime);
            } catch {} // folder may not exist yet — empty list
            return json(res, 200, { files: entries });
          }
          if (u.pathname === '/projects/files/get') {
            try {
              const buf = fs.readFileSync(safe(body.name));
              if (buf.length > 25 * 1024 * 1024) return json(res, 413, { error: 'file too large to download via this surface' });
              return json(res, 200, { name: path.basename(body.name), b64: buf.toString('base64') });
            } catch (e) { return json(res, 404, { error: e.message }); }
          }
          if (u.pathname === '/projects/files/put') {
            const b64 = String(body.b64 || '');
            if (b64.length > 34 * 1024 * 1024) return json(res, 413, { error: 'file too large (25MB max)' }); // ~25MB after decode
            const buf = Buffer.from(b64, 'base64');
            if (buf.length > 25 * 1024 * 1024) return json(res, 413, { error: 'file too large (25MB max)' });
            try {
              const pth = safe(body.name);
              fs.mkdirSync(path.dirname(pth), { recursive: true });
              fs.writeFileSync(pth, buf);
              return json(res, 200, { ok: true, name: path.basename(body.name), bytes: buf.length });
            } catch (e) { return json(res, 400, { error: e.message }); }
          }
          if (u.pathname === '/projects/files/remove') {
            try { const pth = safe(body.name); if (pth === root) throw new Error('refusing to remove the root'); fs.rmSync(pth, { force: true }); return json(res, 200, { ok: true }); }
            catch (e) { return json(res, 400, { error: e.message }); }
          }
        }
      } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 404, { error: 'unknown projects route' });
    }

    res.writeHead(404, SEC); res.end('not found');
  } catch (e) { if (!res.headersSent) res.writeHead(500, SEC); res.end('error'); log('handler', e.message); }
};

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  // persist the root swissnum so dan's link is stable across restarts.
  let rootSwiss;
  try { rootSwiss = (await fs.promises.readFile(SEED_FILE, 'utf8')).trim(); } catch {}
  if (!rootSwiss || !newSwissRe.test(rootSwiss)) {
    const crypto = await import('node:crypto');
    rootSwiss = crypto.randomBytes(16).toString('hex');
    await fs.promises.mkdir(path.dirname(SEED_FILE), { recursive: true });
    await fs.promises.writeFile(SEED_FILE, rootSwiss, { mode: 0o600 });
  }
  registerRoot(rootSwiss);
  void rootNode;

  // Build the HomeAssistant object trie (best-effort; HA actions need it).
  buildHomeAssistant().then(r => log(r.ok ? `HomeAssistant trie: ${r.rooms} rooms, ${r.entities} entities (${r.excluded} agent/pipeline entities excluded; registry:${r.withRegistry})` : `HomeAssistant unavailable: ${r.error}`)).catch(e => log('HA build', e.message));
  buildAgents().then(r => log(r.ok ? `Agent roster: ${r.count} personas (${r.names.join(', ')})` : `Agent roster unavailable: ${r.error}`)).catch(e => log('agents build', e.message));
  buildContacts().then(r => log(r.ok ? `Address book: ${r.count} contacts (NextCloud CardDAV)` : `Address book unavailable: ${r.error}`)).catch(e => log('contacts build', e.message));
  buildKazputer().then(r => log(r.ok ? `Kazputer admin: "${r.name}" in inventory` : `Kazputer admin unavailable: ${r.error}`)).catch(e => log('kazputer build', e.message));

  // scheduled-agent tick: fire any Project scheduled agent whose nextAt has passed. Serialized
  // (one at a time) so concurrent runs can't thrash the model; recurrence advances in runProjectAgent.
  let ticking = false;
  const schedTick = async () => {
    if (ticking) return; ticking = true;
    try {
      const t0 = Date.now();
      for (const p of projects.listProjects()) for (const a of (p.scheduledAgents || [])) {
        if (!a.enabled) continue;
        const due = a.nextAt ? new Date(a.nextAt).getTime() : NaN;
        if (Number.isNaN(due)) { projects.updateScheduledAgent(p.id, a.id, { nextAt: projects.computeNextAt(a.schedule, t0) }); continue; }
        if (due <= t0) { try { await runProjectAgent(p, a); } catch (e) { log('schedTick run', e.message); } }
      }
    } catch (e) { log('schedTick', e.message); } finally { ticking = false; }
  };
  setInterval(() => { schedTick().catch(e => log('schedTick', e && e.message)); }, 30000);
  log('scheduled-agent tick armed (30s)');

  for (const ip of BIND) { const s = http.createServer(handler); s.on('error', e => log('bind', ip, e.message)); s.listen(PORT, ip, () => log(`field agent on http://${ip}:${PORT}`)); }
  log(`ROOT CAP LINK (full bundle): ${BASE_URL}/#cap=${rootSwiss}`);
  log(`STT ${WHISPER}; LLM gemma tinix:8003; delegate ${process.env.DELEGATE_MODEL || 'claude-opus-4-8'}`);
};

// flush durable balances on a clean shutdown (systemd restart sends SIGTERM) so the last debits persist.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const ac of runs.values()) { try { ac.abort(); } catch { /* */ } } try { purseStore.flushNow(); } catch { /* best-effort */ } process.exit(0); });

main().catch(e => { log('FATAL', e && e.stack || e); process.exit(1); });
