// server.mjs — the field agent as an Endo-permissioned host service (Recipe A,
// ENDO-PUBLISHING.md). The agent's authority is a bundle of object capabilities
// reached ONLY through a swissnum in the #cap= URL fragment. Binding the bare
// URL grants NOTHING; the root link grants the full bundle; a share() link
// grants exactly one power. Voice chat runs the cap-confined tool agent over
// whatever bundle the presented cap resolves to.
//
//   browser mic ─VAD→ /stt (whisper) ─→ /chat {cap} ─→ runAgentCode(toolboxFor(cap))
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
import { extractPdf } from './pdf-extract.mjs';
import { roleList, getRole, setCustomRoles, customRoleNames } from './agent-roles.mjs';
import { buildUserContent, callLLM } from '../../ocapn-noise/tool-bridge.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';
// CodeMode is the ONE agent loop: the agent acts by writing a composable JS program per turn, run in a
// SES Compartment endowed with exactly its caps (lexical confinement), and ends the turn via the
// answer()/ask()/blocked() scope functions. The legacy text-marker loop (runAgent) was retired. See codemode.mjs.
const AGENT_RUNNER = runAgentCode;
import { readAsks, getAsk, answerAsk, setAskStatus, formatAnswers, getSecret, storeNamedSecret } from './asks-store.mjs';
import { makeConnectors } from './connectors.mjs';
import { makeCustomTools, TOOL_AUTHORING_GUIDE } from './custom-tools.mjs';
import { makeReviewedFixer } from './self-heal.mjs';
import { makeInterjections } from './interjections.mjs';
import { makeToolShares } from './tool-shares.mjs';
import { makeComponentGit } from './component-git.mjs';
import { makeComponentSync } from './component-sync.mjs';
import { renderCheck } from './render-check.mjs';
import { makeUserStore } from './user-store.mjs';
import { makeByoStore } from './byo-store.mjs';
import { makeIslandSource } from './island-source.mjs';
import { reuseFirstPreamble } from './component-catalog.mjs';
import { addBacklog } from './improvement-backlog.mjs';
import { scanText, smellFeedback } from './render-guard.mjs';
import { inpaint as inpaintGpu } from './gpu-inpaint.mjs';
import { STARTER_RING } from './system-map.mjs';
import { makeInvitePolicies } from './invite-policy.mjs';
import { makeInviteAllowances } from './invite-allowance.mjs';
import { makeBlueskyEligibility } from './bluesky-raindrop.mjs';
import { makeBlueskyClaim } from './bluesky-claim.mjs';
import { makeBlueskyOAuth } from './bluesky-oauth.mjs';
const connectors = makeConnectors({ getSecret }); // owner-side registry (same connectors.json the agent calls)
// SELF-HEAL (designs/self-healing-errors.md): when an admitted custom tool THROWS at runtime, rewrite its source
// so the original call RESOLVES with the repaired value instead of bubbling an error. Single-file tools (the body
// of make(powers)); the repaired tool stays EXACTLY as confined (only state/grains/console — a source rewrite
// can't widen authority). Bounded by the healer (2 tries); every patch logged on the tool.
//   • the fixer is primed with the SAME documents the tool's agent has — the authoring contract + this tool's own
//     review history (handed in via ctx from custom-tools.call), so it repairs by the same rules the author knew;
//   • every PATCH then undergoes the SAME adversarial review panel a proposed tool faces (runReviewPanel); a
//     critically-flawed patch is refused rather than auto-applied (makeReviewedFixer).
// On by default (adopting the strategy); SELF_HEAL=0 disables it (falls back to a plain {ok:false,error}).
const rawHealFix = async ({ source, error, label, ctx = {} }) => {
  if (typeof source !== 'string') return null; // multi-file / imported-bundle tools: skip for now → graceful
  const reviewDoc = ctx.review ? `\n\nThis tool's admission review (worst: ${ctx.review.worst}):\n${(ctx.review.findings || []).map(f => `- [${f.severity}] ${f.discipline}: ${String(f.report || '').slice(0, 180)}`).join('\n')}` : '';
  const sys = `You repair a CONFINED agent-authored JS tool that threw at runtime. Fix the SPECIFIC error while preserving the tool's intent and its method/return shape. Reply with ONLY the corrected body — no markdown fence, no prose.\n\nThe authoring contract you must obey (the same one the tool's author had):\n${ctx.guide || ''}${reviewDoc}`;
  const usr = `Tool: ${ctx.name || label}\n${ctx.description ? `Purpose: ${ctx.description}\n` : ''}Invoked as: ${ctx.method ? `method "${ctx.method}"` : '(single function)'} with args ${JSON.stringify(ctx.args || {}).slice(0, 400)}\nIt threw: ${error}\n\n--- current body ---\n${source}\n--- end ---\n\nReturn the corrected body only.`;
  let out;
  try { out = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: usr }], process.env.SELF_HEAL_MODEL || 'default', { maxTokens: 1500 }); }
  catch { return null; }
  const fixed = String((out && out.text) || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!fixed || fixed === source) return null;
  return { source: fixed, summary: `auto-repair after: ${String(error).slice(0, 70)}` };
};
const selfHealFixer = makeReviewedFixer({
  fix: rawHealFix,
  review: async ({ source, ctx = {} }) => runReviewPanel({ name: ctx.name, description: ctx.description, code: source, kind: ctx.kind }, { callLLM, ranAt: new Date().toISOString() }),
}); // a self-heal patch clears the same adversarial panel as any proposed tool; a critical patch is refused
const customTools = makeCustomTools(process.env.SELF_HEAL === '0' ? {} : { fix: selfHealFixer }); // owner-side review/admit (same custom-tools.json the agent reads)
import { makeAppStore } from './app-state.mjs';
import { makePurse } from './purse.mjs';
import { makePurseStore } from './purse-store.mjs';
import { makeMeteredLLM } from './meter.mjs';
import { listTimers, cancelTimer } from '../capture/timers.mjs';
import { loadStripeCfg, stripeConfigured, recordPending, checkoutForm, verifyWebhook, settleEvent } from './pay.mjs';
import { gatorConfigured, recordDelegation, redeemDelegation, getSubscription, subscriptionStatus, autoTopup, normalizeGrant, grantParams } from './delegation-pay.mjs';
import { budgetLine, costOf } from './costModel.mjs';
import { makeTollBridge } from './toll-bridge.mjs';
import { makeLiveCells } from './live-cells.mjs';
import { makeComponentShares } from './component-shares.mjs';
import { makeForks } from './forks.mjs';
import { makeComponentBacklog } from './component-backlog.mjs';
import { makeDistTrust } from './dist-trust.mjs';
import { makeBlossom } from './blossom.mjs';
import * as projects from './projects.mjs';
import { makeMeetingScribe } from './meeting-scribe.mjs';
import { opusComplete, composeDelegateProposal } from './delegate.mjs';
import { runReviewPanel } from './review-panel.mjs';
import { postInternal, listInternal } from './internal-messages.mjs';
import { reviseToConverge } from './revise-loop.mjs';
import { notify, topicForKey } from '../capture/notify.mjs';
import { writeRating, ratingsDir } from './eval-ratings.mjs';
// THE PERSONAL/PLATFORM SEAM (Packing up for Dweb): personal config + state dirs resolve through
// field-config so FIELD_PERSONAL_ROOT (the encrypted volume) moves them together. Defaults identical on the NUC.
import { CONFIG_DIR, STATE_DIR, VOICE_STATE_DIR, DASH_STATE_DIR, FIELD_MODE, configSummary } from './field-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/home/dan';
const PORT = Number(process.env.PORT) || 8778;
const BIND = (process.env.BIND ? process.env.BIND.split(',').map(s => s.trim()).filter(Boolean) : ['100.83.80.102', '127.0.0.1']); // tailnet IP + loopback — never 0.0.0.0 (overridable for staging)
// FIELD_LOCKDOWN couples the two halves of the confined-fork render path so they can NEVER drift apart:
// (1) the app shell is served with a lockdown marker (<html data-field-lockdown="1">) that islands.js reads
//     to call lockdown({overrideTaming:'severe'}) before app.js runs, and
// (2) its CSP grants script-src 'unsafe-eval' — REQUIRED for SES to install its safe evaluators (without it,
//     tameFunctionConstructors silently no-ops: the realm freezes but the Function constructor stays a host
//     escape — proven in lockdown-survive.staging.test.cjs). 'unsafe-eval' is SAFE here precisely because SES
//     then tames eval/Function; we only relax it when lockdown is actually on. OFF (default) = today's strict CSP.
const FIELD_LOCKDOWN = process.env.FIELD_LOCKDOWN === '1';
// Public-facing base for cap URLs. The browser mic (getUserMedia) requires a
// SECURE CONTEXT, so the app is fronted by `tailscale serve` HTTPS on the tailnet
// (https://archua.taildd002.ts.net) — NOT public. Cap links must use that origin.
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://100.83.80.102:${PORT}`;
// PUSH notifications are tapped on a PHONE via the public ntfy, so their deep-links must open OFF-tailnet. Use the
// public web origin (agentc.chu.vmkqx.com) for notification `click` links, not the tailnet BASE_URL. Falls back to
// BASE_URL if PUBLIC_WEB_URL is unset (e.g. in tests).
const WEB_URL = process.env.PUBLIC_WEB_URL || BASE_URL;
const WHISPER = process.env.STT_URL || 'http://192.168.50.226:8000/v1/audio/transcriptions';
const STT_MODEL = process.env.STT_MODEL || 'deepdml/faster-whisper-large-v3-turbo-ct2';
const OUT = process.env.OUT_DIR || `${VOICE_STATE_DIR}/out`;
const toolShares = makeToolShares({ dir: `${VOICE_STATE_DIR}/tool-shares` }); // share-as-factory/instance + meter + charge
const COMPONENT_GIT_DIR = process.env.COMPONENT_GIT_DIR || `${VOICE_STATE_DIR}/component-git`;
const componentGit = makeComponentGit({ baseDir: COMPONENT_GIT_DIR }); // each component's SOURCE as a git-as-Endo object (version / fork / revert). Env-overridable so a staging/test instance does NOT write broken-out components into the live gallery (the reason it filled with probes).
// DURABILITY (live-editable plan): mirror every component/fork repo to a remote (gitea) so a local DB/disk
// failure loses no history. OPT-IN — a no-op unless COMPONENT_GIT_REMOTE is set, so no surprise outward push.
const componentSync = makeComponentSync({ baseDir: COMPONENT_GIT_DIR, log: (...a) => log(...a) }); // lazy: `log` is defined later in the file (avoid the TDZ at module top)
// MULTI-USER (live-editable plan): per-user capabilities — minted on first open (INVITE-ONLY), storing prefs +
// a Root pointer so each user runs their own app variant over the shared component fork-tree. cap-hygiene: the
// user-cap is stored only as a hash. No public minting (dan's call: invite-only / Tailnet-private).
const userStore = makeUserStore({ file: process.env.USERS_FILE || `${CONFIG_DIR}/users.json` });
// BYO inference: a user can connect their OWN anthropic/openrouter account → their turns run unmetered on it.
const byoStore = makeByoStore({ file: process.env.BYO_STORE || `${CONFIG_DIR}/byo-providers.json`, getSecret, storeNamedSecret });
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
  componentSync.schedule(id); // mirror to the durable remote (debounced; no-op unless a remote is configured)
  return { ok: true, version: rec.version, review, note: 'Edited — committed as a new version + applied to the live component. Revert from the Components tab if you don\'t like it.' };
};

// ── review→revise: feed the panel's findings BACK to the developer to INTEGRATE / NOTE / UNIFY, then
//    re-review — so a flagged component CONVERGES toward an elegant solution instead of dead-ending at
//    admit/reject. The dialogue (each round's resolutions) is surfaced so admission is informed. ──
const REVISE_SYS = 'You are the DEVELOPER revising a proposed confined library component to address the review panel\'s findings. The source is the BODY of make(powers) (Endo unconfined-guest convention) — SES-confined: NO fs, network, import, or ambient globals; persist via powers.state / powers.grains. For EACH finding do ONE of: INTEGRATE (change the code so the finding no longer applies), NOTE (it is a false positive or an acceptable trade-off — keep the code, explain briefly), or UNIFY (several findings share one root cause — solve them together with ONE elegant change). Prefer unifying related findings into a clean solution over piecemeal patches. Keep the component\'s purpose + its exports/imports intact. Reply with EXACTLY: a single ```js fenced code block containing the COMPLETE revised make-body, then a line "RESOLUTIONS:" followed by one bullet per finding formatted "- <discipline> (<severity>): <integrate|note|unify> — <how>". No other prose.';
const reviseComponentSource = async ({ source, findings, name, description }) => {
  const ftext = (findings || []).map(f => `- [${f.severity}] ${f.discipline}: ${String(f.report || '').slice(0, 900)}`).join('\n') || '(no specific findings)';
  const out = String((await opusComplete({ system: REVISE_SYS, prompt: `Component "${name}" — ${description}\n\nCurrent source:\n\`\`\`js\n${String(source).slice(0, 16000)}\n\`\`\`\n\nReview panel findings to address:\n${ftext}`, maxTokens: 4000 })) || '');
  const code = extractJs(out) || String(source);
  const resBlock = out.split(/RESOLUTIONS:/i)[1] || '';
  const resolutions = resBlock.split('\n').map(l => l.replace(/^[\s>*-]+/, '').trim()).filter(Boolean).slice(0, 20)
    .map(l => { const m = l.match(/^(.+?)\s*\(([^)]+)\)\s*:\s*(\w+)\s*[—–-]\s*(.*)$/); return m ? { finding: `${m[1].trim()} (${m[2].trim()})`, action: m[3].toLowerCase(), how: m[4].trim() } : { finding: l.slice(0, 140), action: '', how: '' }; });
  return { source: code, resolutions };
};
// run the loop on ONE pending tool; persist the converged source (+ a git version) + the dialogue + the final review.
const reviseTool = async (t) => {
  const code = t.code || (t.files && t.files['tool.js']) || '';
  if (!code.trim()) return { ok: false, error: 'the revise loop handles single-file components for now' };
  const out = await reviseToConverge({
    record: { name: t.name, description: t.description, kind: t.kind, code, review: t.review },
    revise: reviseComponentSource,
    runPanel: r => runReviewPanel({ name: r.name, description: r.description, kind: r.kind, code: r.code }, { callLLM, ranAt: new Date().toISOString() }),
    maxRounds: 3,
  });
  if (out.rounds > 0 && out.source && out.source !== code) {
    customTools.setSource(t.id, { 'tool.js': out.source });
    customTools.setReview(t.id, out.review);
    try { await componentGit.commit(t.id, { 'tool.js': out.source }, `revise: addressed review (${out.rounds} round(s), worst→${out.review.worst})`); } catch { /* git best-effort */ }
  }
  customTools.setReviseLog(t.id, { rounds: out.rounds, converged: out.converged, worst: out.review.worst, log: out.reviseLog, at: new Date().toISOString() });
  return { ok: true, converged: out.converged, rounds: out.rounds, worst: out.review.worst, reviseLog: out.reviseLog };
};
// AUTONOMOUS but BOUNDED: at most one revise loop at a time; each /tools/review poll kicks the worst
// un-revised high/critical pending tool in the background, so the backlog self-improves without a stampede
// of Opus calls. AUTO_REVISE=0 disables; the manual ✨ Revise button calls reviseTool directly.
const revising = new Set();
const AUTO_REVISE = process.env.AUTO_REVISE !== '0';
const maybeAutoRevise = () => {
  if (!AUTO_REVISE || revising.size) return;
  const cand = customTools.listAll().filter(t => t.status === 'pending' && !t.reviseLog && t.review && (t.review.worst === 'high' || t.review.worst === 'critical'))
    .sort((a, b) => (b.review.worst === 'critical' ? 1 : 0) - (a.review.worst === 'critical' ? 1 : 0))[0];
  if (!cand) return;
  revising.add(cand.id);
  reviseTool(cand).then(r => log('auto-revise', cand.name, `→ ${r.rounds || 0} round(s), worst ${r.worst || '?'}, converged ${r.converged}`)).catch(e => log('auto-revise', cand.name || '?', 'failed', e.message)).finally(() => revising.delete(cand.id));
};
// AUTONOMOUS TRIAGE: push every PENDING tool through the review panel → (auto-revise high/critical) →
// AUTO-ADMIT to the library when it's non-critical — so a proposed tool lands in the library on its own merit
// (the panel is the gate, not a manual owner click), and the LEGACY pending tools that predate the panel get
// the same treatment. Bounded (one op per tick) so it can't stampede Opus. AUTO_ADMIT=0 keeps admission manual.
const AUTO_ADMIT = process.env.AUTO_ADMIT !== '0';
let triaging = false;
const triageTick = async () => {
  if (triaging) return; triaging = true;
  try {
    const pend = customTools.listAll().filter(t => t.status === 'pending');
    // 1) review any pending tool that has no review yet (the legacy ones predate the panel)
    const unreviewed = pend.find(t => !t.review);
    if (unreviewed) { try { const rv = await runReviewPanel(unreviewed, { callLLM, ranAt: new Date().toISOString() }); customTools.setReview(unreviewed.id, rv); log('auto-review', unreviewed.name, '→ worst', rv.worst); postInternal({ from: 'agent-c', kind: 'tool-reviewed', title: `reviewed "${unreviewed.name}" — worst: ${rv.worst}`, body: (rv.findings || []).slice(0, 3).map(f => `[${f.severity}] ${f.discipline}`).join(' · ') || 'no findings', toolId: unreviewed.id, by: unreviewed.proposedByName || unreviewed.proposedBy, status: rv.worst }); } catch (e) { log('auto-review', unreviewed.name || '?', e.message); } return; }
    // 2) revise the worst un-revised high/critical (existing bounded loop)
    maybeAutoRevise();
    if (revising.size) return;
    // 3) AUTO-ADMIT a reviewed, NON-critical tool (high ones only after they've been through the revise loop,
    //    so they get the feedback first). Mirrors /tools/admit: commit the source as the start of its lineage.
    if (AUTO_ADMIT) {
      const ready = pend.find(t => t.review && t.review.worst !== 'critical' && (t.review.worst !== 'high' || t.reviseLog));
      if (ready) {
        // Agent C NAMES/ORGANIZES it (the entry agent decides where it fits in the library) — a cheap local
        // call, best-effort; on failure we just admit with no category.
        let org = {};
        try { const o = await callLLM([{ role: 'system', content: 'You are Agent C, organizing your own component library. Given a tool name + description, reply with ONLY compact JSON {"category":"<1-3 word category>","note":"<one short sentence on where it fits / what it is good for>"}. No prose.' }, { role: 'user', content: `${ready.name}: ${String(ready.description || '')}`.slice(0, 800) }], 'default'); const m = /\{[\s\S]*\}/.exec(String(o && o.text || '')); if (m) org = JSON.parse(m[0]); } catch { /* organize is best-effort */ }
        const r = customTools.admit(ready.id);
        if (r.ok) {
          try { await componentGit.commit(ready.id, sourceFilesOf(ready), `admit: ${ready.name}`); } catch (e) { log('auto-admit commit', e.message); }
          log('auto-admit', ready.name, `→ library (review worst: ${ready.review.worst}${org.category ? `, category: ${org.category}` : ''})`);
          postInternal({ from: 'agent-c', kind: 'tool-admitted', title: `admitted "${ready.name}" to the library${org.category ? ` · ${org.category}` : ''}`, body: org.note || String(ready.description || '').slice(0, 300), toolId: ready.id, by: ready.proposedByName || ready.proposedBy, status: `review worst: ${ready.review.worst}` });
          try { await postFeed({ avatar: '🧩', title: `Added "${ready.name}" to your component library`, body: (org.note || String(ready.description || '')).slice(0, 400), status: `auto-admitted${org.category ? ` · ${org.category}` : ''} · review worst: ${ready.review.worst}`, note: ready.proposedBy ? `proposed by ${ready.proposedByName || ready.proposedBy}` : '' }); } catch { /* feed best-effort */ }
        }
      }
    }
  } catch (e) { log('triage', e && e.message); } finally { triaging = false; }
};
if (AUTO_ADMIT) setInterval(() => { triageTick().catch(e => log('triage', e && e.message)); }, 45000).unref?.();

// Editing a confined-Preact ISLAND (its source is a client file → rewrite + rebuild, not make(powers)).
const ISLAND_EDIT_SYS = reuseFirstPreamble() + '\n\nYou are editing a confined-Preact ISLAND — a UI component rendered through @endo/preact-container `renderConfined`. The source is a JS module built with `h(tag, props, children)` hyperscript (NO JSX), pure + stateless (state lives in cells passed via props; render-safe data only — never a swissnum/secret). When the change ADDS UI, compose the kit primitives above (import from ./ui-kit.js) rather than hand-rolling raw `h(\'button\'/\'input\'/…)`; only write new markup when no primitive fits. Apply the user\'s requested change, keep it valid h-based confined Preact, keep the SAME exports and imports (add ONLY from ./ui-kit.js if you adopt a primitive not yet imported), use theme vars not hardcoded colours, and use no DOM/network/fs/ambient access. Reply with ONLY the complete updated file as a single ```js fenced code block — no prose.';
// Editing a user FORK (in-tree confined component): its source is a SINGLE arrow function expression
// `(endowments, props) => vnode`, NOT a module — evaluated in a SES Compartment by client renderSource.
const FORK_EDIT_SYS = reuseFirstPreamble() + '\n\nYou are editing a confined FORK — one UI component rendered inline (no iframe) through @endo/preact-container. The source is a SINGLE arrow function expression `(endowments, props) => vnode` (NOT a module — no import/export statements; they will not evaluate). Build the tree with `endowments.h(tag_or_Component, props, ...children)` hyperscript (NO JSX). The ui-kit primitives (Btn, Card, Chip, List, Banner, Field, TextField, Toggle, SegmentedControl, Table, Stack, Row, …) are available as BARE GLOBALS — use them via `endowments.h(Btn, {...}, ...)` rather than hand-rolling raw markup when one fits. The fork is PURE + STATELESS: read only from `props`, render render-safe data only (never a swissnum/secret), and use no DOM/network/fs/ambient access (none is reachable — that IS the confinement). Use theme CSS vars, not hardcoded colours. Apply the user\'s requested change and reply with ONLY the complete updated function expression as a single ```js fenced code block — no prose, no `const X =`, no exports.';
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
const SEED_FILE = process.env.SEED_FILE || `${CONFIG_DIR}/root.swiss`;
const CHATS_DIR = `${VOICE_STATE_DIR}/chats`; // per-cap chat list + transcripts (cross-device sync)
const chatStorePath = cap => path.join(CHATS_DIR, crypto.createHash('sha256').update(String(cap || '')).digest('hex').slice(0, 40) + '.json');
// notification inbox (the 🔔 bell): the dashboard's durable feed is the shared data
// endowment; per-cap dismissed-state lives here. An entry "needs attention" by its status.
const FEED_FILE = `${DASH_STATE_DIR}/feed.json`;
const NOTIF_DIR = `${VOICE_STATE_DIR}/notif-triage`;
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
// ── FILE-POWER folders the owner can browse/add-to via the File-browser island.
//    A named allowlist of real roots; the /files endpoints navigate + read/write
//    WITHIN a root only (path-traversal-guarded). Root-gated (owner-only). This is
//    the data layer behind the confined file-browser island + the "add files to a
//    folder" affordance. Read-only roots (reference/library) are omitted for now. ──
const FILE_ROOTS = [
  { key: 'vault', label: '📓 Notes (vault)', dir: path.join(HOME, 'obsidian/vault') },
  { key: 'home', label: '🏠 Agent home (projects)', dir: HOME_BASE },
  { key: 'tada', label: '✅ TADA (done/outbox)', dir: path.join(HOME, 'TADA') },
];
const fileRoot = key => FILE_ROOTS.find(r => r.key === String(key || '')) || null;
// resolve a root-relative path safely (no escape), returning the absolute path or throwing.
const fileSafe = (root, rel) => {
  const base = path.resolve(root.dir);
  const pth = path.resolve(base, String(rel || '').replace(/^\/+/, ''));
  if (pth !== base && !pth.startsWith(base + path.sep)) throw new Error('path escapes the folder');
  return pth;
};

// ── APP-SHARES: a scoped, metered grant of an app (island) to a non-owner. The owner mints a confined
//    scoped cap (mintScopedCap — persisted/re-registered across restart) and this record attenuates WHAT it
//    can reach (e.g. which file roots) alongside a funded allowance purse. Keyed by a hash of the cap, never
//    the raw swissnum. The recipient opens /apps/<app>#cap=<scopedcap>; the backend authorizes via
//    appShareFor + attenuates + (for inference apps) meters against the purse. First step of the
//    break-out → minimize → fork → re-share lifecycle. ──
const appKey = c => crypto.createHash('sha256').update(String(c || '')).digest('hex').slice(0, 16);
const APP_SHARES_FILE = `${VOICE_STATE_DIR}/app-shares.json`;
let appShares = {};
try { appShares = JSON.parse(fs.readFileSync(APP_SHARES_FILE, 'utf8')) || {}; } catch { appShares = {}; }
const saveAppShares = () => { try { fs.mkdirSync(path.dirname(APP_SHARES_FILE), { recursive: true }); fs.writeFileSync(APP_SHARES_FILE, JSON.stringify(appShares, null, 2)); } catch { /* */ } };
const appShareFor = cap => (cap ? appShares[appKey(cap)] || null : null);
// file roots a caller may reach: ALL for root; for a file-browser app-share, only its attenuated subset.
const allowedFileRoots = (node, cap) => {
  // A host-shell holder can already `cat` anything via hostExec, so withholding the STRUCTURED file browser
  // from it is pointless — and worse, it makes a host-powered agent wrongly conclude it "can't traverse the
  // filesystem" (the scoped-dfb48b2f0 case: granted ["host"] yet fileList returned []). The stronger power
  // subsumes the weaker; surface the roots to it. (The real cure is the Inventory/by-reference model.)
  if (node && (node.isRoot || (node.powers && node.powers.has('host')))) return FILE_ROOTS;
  const sh = appShareFor(cap);
  if (sh && sh.app === 'file-browser' && Array.isArray(sh.roots)) return FILE_ROOTS.filter(r => sh.roots.includes(r.key));
  return [];
};

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
const MEMO_RUNS_FILE = process.env.MEMO_RUNS_FILE || `${VOICE_STATE_DIR}/memo-runs.json`;
const DEV_QUEUE_FILE = `${STATE_DIR}/dev-queue.jsonl`; // dev-task visibility + thread replies
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
const INPUT_QUEUE = `${DASH_STATE_DIR}/input-queue.json`; // the off-app drain (input-runner polls this)
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
const SEED_CHATS_FILE = process.env.SEED_CHATS_FILE || `${VOICE_STATE_DIR}/seed-chats.json`;
const SCHEDULED_SEED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ⏰ scheduled-agent runs are ephemeral — GC after a week
// readSeedChats GC's expired scheduled runs from the RETURNED view; since writeSeedChats's caller does a
// read→unshift→write, the next scheduled run also prunes them from the file. Non-scheduled seeds are kept.
const readSeedChats = async () => { try { const all = (JSON.parse(await fs.promises.readFile(SEED_CHATS_FILE, 'utf8')).chats) || []; const cutoff = Date.now() - SCHEDULED_SEED_TTL_MS; return all.filter(c => !(c && c.source === 'scheduled' && (c.ts || 0) < cutoff)); } catch { return []; } };
const writeSeedChats = async chats => { await fs.promises.mkdir(path.dirname(SEED_CHATS_FILE), { recursive: true }); await fs.promises.writeFile(SEED_CHATS_FILE, JSON.stringify({ chats: chats.slice(0, 80) }, null, 2)); };

// ── operator-defined specialist ROLES (Settings → Specialists). Persisted here,
//    merged over the built-in agent-roles catalog via setCustomRoles so a custom
//    role (or an override of a built-in) is immediately employable by the entry
//    agent. Loaded at boot; rewritten + re-pushed on every /roles/save|delete. ──
const CUSTOM_ROLES_FILE = `${VOICE_STATE_DIR}/custom-roles.json`;
const readCustomRoles = () => { try { return JSON.parse(fs.readFileSync(CUSTOM_ROLES_FILE, 'utf8')) || {}; } catch { return {}; } };
const writeCustomRoles = map => { fs.mkdirSync(path.dirname(CUSTOM_ROLES_FILE), { recursive: true }); fs.writeFileSync(CUSTOM_ROLES_FILE, JSON.stringify(map, null, 2)); };
try { setCustomRoles(readCustomRoles()); } catch (e) { log('load custom-roles', e.message); }
const ROLE_NAME_RE = /^[a-z][a-zA-Z0-9-]{0,40}$/; // safe role key; camelCase allowed to match built-ins (testRunner, securityAudit)
const ROLE_TIERS = new Set(['strong', 'mid', 'cheap']);
const ROLE_VIAS = new Set(['subagent', 'dev']);
// Validate + normalize a role spec from the editor. Powers are clamped to the real power set
// (a role can only ever be GRANTED powers the employer holds, but we still keep the catalog honest).
const sanitizeRole = raw => {
  const r = raw || {};
  const powers = [...new Set((Array.isArray(r.powers) ? r.powers : []).map(String).filter(p => ALL_POWERS.includes(p)))];
  return {
    label: String(r.label || '').slice(0, 80) || 'Custom role',
    tier: ROLE_TIERS.has(r.tier) ? r.tier : 'mid',
    via: ROLE_VIAS.has(r.via) ? r.via : 'subagent',
    writes: !!r.writes,
    isolation: r.isolation ? String(r.isolation).slice(0, 40) : null,
    powers,
    blurb: String(r.blurb || '').slice(0, 400),
    prompt: String(r.prompt || '').slice(0, 8000),
    output: String(r.output || '').slice(0, 1000),
    // standing reference docs folded into the role's prompt at run time (the fold-docs pattern)
    foldScope: String(r.foldScope || '').replace(/^\/+/, '').replace(/\/+$/, '').slice(0, 200),
    foldDocs: [...new Set((Array.isArray(r.foldDocs) ? r.foldDocs : []).map(p => String(p || '').replace(/^\/+/, '').trim()).filter(Boolean))].slice(0, 30),
    custom: true,
  };
};

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
const DEFAULT_ALLOWANCE_FILE = `${OUT}/default-allowance.json`; // the owner's Settings value, persisted across restarts
let defaultAllowance = DEFAULT_ALLOWANCE;
try { const v = JSON.parse(fs.readFileSync(DEFAULT_ALLOWANCE_FILE, 'utf8')); if (Number.isFinite(v && v.uusd)) defaultAllowance = Math.max(0, Math.round(v.uusd)); } catch { /* default */ }
const saveDefaultAllowance = () => { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(DEFAULT_ALLOWANCE_FILE, JSON.stringify({ uusd: defaultAllowance })); } catch { /* best-effort */ } };
// SPEND LEDGER — cumulative allowance USED per chat (µUSD), accumulated each turn + persisted, so the
// Settings "most expensive conversations" leaderboard is instant + accurate (used, not granted) and survives
// restarts, instead of N per-chat budget probes on every open. Keyed by sessionId (the chat id, not a cap).
const SPEND_LEDGER_FILE = `${OUT}/spend-ledger.json`;
const spendLedger = new Map();
try { const d = JSON.parse(fs.readFileSync(SPEND_LEDGER_FILE, 'utf8')); if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) spendLedger.set(k, Number(v) || 0); } catch { /* none yet */ }
let spendSaveT = null;
const saveSpendLedger = () => { if (spendSaveT) return; spendSaveT = setTimeout(() => { spendSaveT = null; try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(SPEND_LEDGER_FILE, JSON.stringify(Object.fromEntries(spendLedger))); } catch { /* */ } }, 2000); };
const addSpend = (sid, uusd) => { const a = Math.max(0, Math.round(Number(uusd) || 0)); if (!a) return; spendLedger.set(String(sid), (spendLedger.get(String(sid)) || 0) + a); saveSpendLedger(); };
const chatPurses = new Map(); // `${cap}:${sid}` → purse
// Durable balances: a purse's mutations persist (hashed key → {balance,granted}); on boot a chat's purse
// rehydrates from disk instead of resetting to the default allowance. (Increment 6 swaps this for agora's
// journaled bank behind the same shape.)
const purseStore = makePurseStore({ file: `${VOICE_STATE_DIR}/purses.json` });
// Bluesky-claim namespaces are ZERO-UNTIL-CLAIM (dan): every chat under such a namespace shares ONE wallet seeded
// at ZERO (not the per-chat default allowance); only an eligible claim funds it. Set once bluesky-claim exists.
let blueskyIsNamespace = () => false;
const BSKY_NAMESPACE_SID = '_namespace'; // the single shared wallet a Bluesky namespace's chats all draw from
// purseAt: the one durable-purse accessor (rehydrate from purseStore, persist every mutation).
const purseAt = (k, seed) => {
  let p = chatPurses.get(k);
  if (!p) {
    const saved = purseStore.get(k); // {balance, granted} if this purse was ever persisted
    p = makePurse(saved ? saved.balance : seed, { granted: saved ? saved.granted : undefined, onChange: (b, g) => purseStore.set(k, b, g) });
    if (!saved) purseStore.set(k, p.balance(), p.granted()); // record the initial grant so a restart before any spend still restores it
    chatPurses.set(k, p);
  }
  return p;
};
// ── INVITE-CARRIED ALLOWANCE (User Agency): an invite can carry a µUSD usage-credit allowance. The
// member's caps then share ONE zero-seeded wallet credited exactly what the OWNER's invite wallet was
// debited (conservation — fund() there is root-gated, so members can't mint credit). purseFor routes it.
const inviteAllowances = makeInviteAllowances({ file: `${VOICE_STATE_DIR}/invite-allowances.json` });
const ROOT_WALLET_SEED = Number(process.env.ROOT_WALLET_UUSD) || 100_000_000; // $100 default; owner tops up via /wallet/fund
const rootWallet = () => purseAt('wallet:root', ROOT_WALLET_SEED);
// grantFromRootWallet(uusd) — the CONSERVED credit source for owner-issued invites: assert-then-charge the
// owner's invite wallet; `deposit(scopedCap)` credits the new member's shared wallet once the cap exists.
// (Two-phase, same contract as invite-policy's fundAllowance — a refusal leaves both ledgers untouched.)
const grantFromRootWallet = uusd => {
  const w = rootWallet();
  const amt = Math.max(0, Math.round(Number(uusd) || 0));
  if (!w.canAfford(amt)) return { ok: false, error: `your invite wallet can't cover $${(amt / 1e6).toFixed(2)} (only $${(w.balance() / 1e6).toFixed(2)} left) — top it up under Settings → Usage`, remaining: w.balance() };
  w.debit(amt);
  return { ok: true, deposit: scopedCap => { const wid = inviteAllowances.fund(scopedCap, amt); purseAt(`invite-wallet:${wid}`, 0).credit(amt); }, remaining: w.balance() };
};
const purseFor = (cap, sid) => {
  const wid = inviteAllowances.walletIdFor(cap); // an allowance-funded invite (or a cap minted from one)?
  if (wid) return purseAt(`invite-wallet:${wid}`, 0); // ONE shared wallet, zero-seeded — the invite's grant funded it
  const ns = blueskyIsNamespace(cap); // a signed-in Bluesky user's namespace?
  const realSid = ns ? BSKY_NAMESPACE_SID : sid; // share one wallet across all their chats
  const seed = ns ? 0 : defaultAllowance; // zero until they claim; the claim credits this same wallet
  return purseAt(`${cap}:${realSid}`, seed);
};
// Central toll-bridge for EDIT (AI-credit spend) + SAVE/HOST (storage×time) rights, used by the SPWA
// self-editors. Same µUSD purse ledger as inference, in a separate `toll:<account>` namespace.
const tollBridge = makeTollBridge({ purseStore, makePurse, costOf, ledgerFile: `${VOICE_STATE_DIR}/hosting-ledger.json` });
// Live grain transport for chat widgets: a browser subscribes to named server cells (e.g. ha:<handle>)
// over a streamed response and gets PUSHED updates — no polling. Cap-gated per cell. (Defined after
// nodeFor below via a late binding; see the /cells/subscribe route.)
let liveCells = null;
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

// MAGIC WAND filler (designs/self-healing-errors.md + vault [[magic wand]]): when an agent asks a specialist
// that doesn't exist, infer its config so the system can materialize it (powers are re-bounded ⊆ the caller in
// agent-caps — this only SUGGESTS). On by default; SELF_HEAL=0 disables (a miss → plain "no such specialist").
const fillSpecialist = process.env.SELF_HEAL === '0' ? undefined : async ({ name, request, origin, availablePowers = [] }) => {
  const sys = 'You configure a NEW confined specialist sub-agent that an agent just referenced by name but that does not exist yet. Infer what it should be from its NAME + the request it was handed. Reply with ONLY compact JSON {"domain":"<the kind of requests it handles>","powers":["<the FEWEST powers it needs, chosen ONLY from the available list>"],"instructions":"<its standing persona, 2-4 sentences>"}. No prose, no markdown fence.';
  const usr = `Specialist name: ${name}\nRequest it was asked to handle: ${String(request || '').slice(0, 800)}\n${origin ? `Originating user request: ${String(origin).slice(0, 400)}\n` : ''}Available powers (choose a subset): ${(availablePowers || []).join(', ')}`;
  let out;
  try { out = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: usr }], process.env.SELF_HEAL_MODEL || 'default', { maxTokens: 600 }); }
  catch { return null; }
  const m = /\{[\s\S]*\}/.exec(String((out && out.text) || ''));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return { domain: String(j.domain || ''), powers: Array.isArray(j.powers) ? j.powers : [], instructions: String(j.instructions || '') }; }
  catch { return null; }
};
// customView — late-bound holder the chat agent's `customView` tool calls to register a renderer it AUTHORED.
// makeFieldAgent runs before `blossom` exists, so the server populates `customView.register` below; the tool
// reads it at call-time. This is the seam that lets a NORMAL chat agent (visible in the trace) be the studio.
const customView = {};
const { rootNode, registerRoot, nodeFor, getProposal, commitProposal, rejectProposal, buildHomeAssistant, buildAgents, buildContacts, buildKazputer, siteDir, downloadFor, getPersona, runScheduledAgent, specialistNudges, runSpecialistNudge, mintScopedCap, rescopeCap, specialistFor, foldedPersonaFor, getFoldDocs, setFoldDocs, agentConfig, saveAgentConfig, haResolveReadOnly, changelog, actOnStagedReview, publishClip, revokeClip, listClips } = makeFieldAgent({ outDir: OUT, baseUrl: BASE_URL, fillSpecialist, customView });
liveCells = makeLiveCells({ nodeFor }); // browser-subscribable live grains (cap-gated)

// ── STANDING SPECIALIST NUDGES tick ──────────────────────────────────────────────────────────────────────────
// Fire due standing nudges: wake the specialist (confined, by id), file its result as a viewable run in its chat,
// and push a deep-linked notification — so a "team" of specialists evolves strategy between turns. Bounded to a
// few per tick so it can't stampede inference; specialists run on the local model so the cost is low.
const fireDueNudges = async () => {
  let due; try { due = specialistNudges.due(); } catch { return; }
  for (const n of due.slice(0, 3)) {
    try {
      const r = await runSpecialistNudge(n);
      const now = new Date().toISOString();
      const answer = r && r.ok !== false ? String(r.answer || '(no output)') : `⚠️ ${(r && r.error) || 'nudge failed'}`;
      const id = `snudge-${crypto.randomBytes(5).toString('hex')}`;
      const seed = { id, title: `🔁 ${n.specialistName}`, ts: Date.now(), source: 'specialist-nudge',
        transcript: n.request, scheduled: { specialist: n.specialistName, at: now, parentChat: n.chatId || '' },
        tx: [{ who: 'you', text: n.request }, { who: 'agent', text: answer, tools: (r && r.toolsUsed) || [], steps: [] }],
        versions: [{ v: 0, label: 'nudge run', env: { persona: `specialist:${n.specialistName}` }, answer, toolsUsed: (r && r.toolsUsed) || [], steps: [], at: now }] };
      try { const seeds = await readSeedChats(); seeds.unshift(seed); await writeSeedChats(seeds); } catch (e) { log('nudge seed', e.message); }
      try { await notify({ title: `🔁 ${n.specialistName}`, message: answer.slice(0, 180), click: `${WEB_URL}/#chat=${id}`, tags: ['robot'] }); } catch { /* best-effort */ }
      specialistNudges.fired(n.id);
      log('nudge', `fired ${n.specialistName} (${n.id})`);
    } catch (e) { log('nudge', `fire ${n && n.id} failed: ${e.message}`); try { specialistNudges.fired(n.id); } catch { /* avoid hot-loop on a poison nudge */ } }
  }
};
setInterval(() => { fireDueNudges().catch(e => log('nudge tick', e && e.message)); }, 60_000).unref?.();

// ── "Sign in with Bluesky → claim credits" ───────────────────────────────────────────────────────────────────
// A user signs in with their Bluesky handle (AT-Protocol OAuth, scope `atproto` = identity only) and ALWAYS gets a
// STABLE per-user namespace (membership seam, keyed on DID — re-sign-in returns the same space). ZERO-UNTIL-CLAIM:
// the namespace's credit wallet starts empty and stays empty until an ELIGIBLE claim (DID on the Raindrop allow-
// list) funds it once; the wallet is shared across the namespace's chats (purseFor routes it). Credit-gated
// features stay locked at zero balance. The OAuth library loads lazily + degrades gracefully if not yet installed.
const blueskyInvitePolicies = makeInvitePolicies({
  file: `${CONFIG_DIR}/bluesky-policies.json`,
  mintNamespaceCap: ({ powers, label }) => { const r = mintScopedCap({ powers, label }); return { swiss: r.swiss, powers: r.powers }; },
  // a policy created with an allowanceUusd funds each new member from the OWNER's invite wallet (conserved);
  // the existing Bluesky policies carry no allowance, so this hook is inert for them.
  fundAllowance: ({ uusd }) => grantFromRootWallet(uusd),
});
const blueskyEligibility = makeBlueskyEligibility({ configFile: `${CONFIG_DIR}/bluesky-raindrop.json` });
const blueskyClaimStore = {
  read: () => { try { return JSON.parse(fs.readFileSync(`${CONFIG_DIR}/bluesky-claims.json`, 'utf8')); } catch { return { byDid: {}, namespaces: {} }; } },
  write: d => { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(`${CONFIG_DIR}/bluesky-claims.json`, JSON.stringify(d, null, 2), { mode: 0o600 }); } catch { /* best-effort */ } },
};
const blueskyClaim = makeBlueskyClaim({
  eligibility: blueskyEligibility,
  invitePolicies: blueskyInvitePolicies,
  ring: STARTER_RING,
  grantUusd: defaultAllowance, // one-time fund an eligible claim grants into the shared namespace wallet
  grantCredits: (scopedCap, uusd) => { purseFor(scopedCap, BSKY_NAMESPACE_SID).credit(uusd); }, // purseFor routes namespaces to the shared zero-seeded wallet
  store: blueskyClaimStore,
});
blueskyIsNamespace = cap => { try { return blueskyClaim.isNamespace(cap); } catch { return false; } }; // arm the zero-until-claim purse routing
// AT-Proto's authorization server fetches our client-metadata over the PUBLIC internet, so the OAuth base MUST be
// the public domain (agentc.chu.vmkqx.com via ngrok) — NOT the tailnet BASE_URL. Read it from the config's
// `publicUrl` (preferred, no systemd edit) → env → BASE_URL. Public exposure stays an explicit operator choice.
const blueskyPublicUrl = (() => {
  try { const c = JSON.parse(fs.readFileSync(`${CONFIG_DIR}/bluesky-raindrop.json`, 'utf8')); if (c.publicUrl) return String(c.publicUrl).replace(/\/$/, ''); } catch { /* fall through */ }
  return process.env.BSKY_OAUTH_BASE_URL || BASE_URL;
})();
const blueskyOAuth = makeBlueskyOAuth({
  baseUrl: blueskyPublicUrl,
  keyFile: `${CONFIG_DIR}/bluesky-oauth-key.json`,
  stateFile: `${VOICE_STATE_DIR}/bluesky-oauth-state.json`,
  sessionFile: `${VOICE_STATE_DIR}/bluesky-oauth-session.json`,
});
// Least-authority cross-user share tokens for a broken-out component: subscribe-only to its frozen cells.
const componentShares = makeComponentShares({ file: `${VOICE_STATE_DIR}/component-shares.json`, makePurse, purseStore });
// User-owned FORKS of confined Preact components (the in-tree, no-iframe model). Any cap-holder owns forks;
// owner = a stable, NON-SECRET id derived from the cap ('root' for the root cap, else a one-way hash — never
// the cap itself, cap-hygiene). Forks render via client renderSource under lockdown; the store is live-safe
// regardless (it only vends source strings, which the client refuses to render unless the realm is frozen).
const forks = makeForks({ file: process.env.FORKS_STORE || `${VOICE_STATE_DIR}/forks.json`, makePurse, purseStore });
const forkOwnerOf = cap => { const n = nodeFor(cap); if (!n) return null; return n.isRoot ? 'root' : `u:${crypto.createHash('sha256').update(`fork-owner:${String(cap)}`).digest('hex').slice(0, 16)}`; };
// Every component/fork project-object carries its own BACKLOG (dan's rule: creating a component
// IMPLICITLY endows the creator with the right to add to + receive requests on its backlog — issue
// requests, errors thrown, and things). Keyed by the object's git identity; the owner facet
// (read / ack / add) is gated by the SAME ownership checks the object's other routes use — designation
// by the id already held, no new strings. Recipients get an attenuated ADD-ONLY verb (see the
// /forks/backlog/report + /components/backlog/report routes); runtime errors auto-file via /error/flag.
const componentBacklog = makeComponentBacklog({ file: process.env.BACKLOG_STORE || `${VOICE_STATE_DIR}/component-backlog.json` });
// The backlog's READ/NOTIFY surface is a PROPAGATOR CELL (live-cells interface, push-fed by the store)
// served through the one /cells/subscribe broker as `backlog:<id>` — owner-only (the attenuated add-only
// facet gains NO subscription). A fork's backlog belongs to forkOwnerOf(cap); a component's to root.
const backlogCellFor = (cap, id) => {
  const target = String(id || '');
  const mine = target.startsWith('fork-') ? !!forks.get(target, forkOwnerOf(cap)) : !!nodeFor(cap)?.isRoot;
  return mine ? { cell: componentBacklog.cellFor(target) } : { error: 'not your component/fork' };
};
// opaque, NON-SECRET origin tag for a share-token filer (never the token itself — cap-hygiene).
const backlogOriginOf = t => `share-${crypto.createHash('sha256').update(`backlog-origin:${String(t || '')}`).digest('hex').slice(0, 8)}`;
// Distribution-trust (Phase 5): the social-collateral graph that decides which fork VERSIONS are approved
// for end-user distribution. Root (the operator) is the base authority; trust flows outward via grants.
const distTrust = makeDistTrust({ file: process.env.DIST_TRUST_STORE || `${VOICE_STATE_DIR}/dist-trust.json`, rootId: 'root' });
// EAGER BLOSSOM (the "render an island per object interface" loop): on first sight of a new interface, an
// agent authors a confined renderer FORK, registered by interface signature + reused forever. Budget caps +
// a per-signature lock keep "eager" from running away. The renderer authoring system prompt:
const RENDERER_SYS = reuseFirstPreamble() + '\n\nYou author a CONFINED, INTERACTIVE RENDERER for one kind of object. The object exposes an interface (a set of methods) and returns DATA; you write a single arrow function expression `(endowments, props) => vnode` (NOT a module — no import/export) that renders `props.value` (a SAMPLE of that data) beautifully AND lets the human ACT on the object.\n\nBUILD with `endowments.h(type, props, ...children)` (NO JSX). `type` is EITHER a raw HTML tag STRING (\'div\',\'button\',\'input\',\'span\',\'ul\',\'li\',…) OR one of the THEMED UI-KIT COMPONENTS below (preferred — they match the app\'s look automatically). Mix freely.\n\n⚠️ THE KIT COMPONENTS TAKE NAMED PROPS, NOT React-style children/events — get this right or they render blank:\n  • `h(Btn,{label:\'Send\',onClick:fn,variant:\'primary\',disabled:bool})` — the button TEXT is the `label` PROP (NOT a child). variant: \'\'|\'primary\'.\n  • `h(TextField,{value,placeholder,onInput:v=>setV(v),onEnter:v=>go(v),disabled})` — onInput/onEnter receive the VALUE STRING directly (NOT an event; there is no e.target). Multiline: `h(Textarea,{value,onInput:v=>setV(v)})`. Dropdown: `h(Select,{value,options:[...],onChange:v=>setV(v)})`.\n  • `h(Chip,{label})` / `h(Badge,{label,kind})` / `h(Avatar,{label})` / `h(EmptyState,{text})` — label/text PROPS.\n  • LAYOUT components take CHILDREN (positional): `h(Stack,null,a,b)` (vertical), `h(Row,null,a,b)` (horizontal), `h(Banner,{kind:\'info\'},text)`, `h(Divider)`.\n  • `h(Card,{title,body,footer})` — a card\'s content is the `body`/`title`/`footer` PROPS (it does NOT render positional children). For a custom card layout, use `h(\'div\',{class:\'ncard\'}, …children)` instead.\n  • `h(List,{items,onSelect})`, `h(Table,{columns,rows})`, `h(ProgressBar,{value,max})`, `h(Spinner,{label})`.\n⚠️ TEXT SLOTS TAKE STRINGS, NOT OBJECTS: a text prop — Card.title/body/footer, Btn/Chip/Badge/Avatar label, EmptyState/Banner text, TextField.value, a Meta part, or any followed cell value — MUST be a string or number. Passing an object/array/promise there renders the literal "[object Object]" (or "[object Promise]") on screen. Render a FIELD (e.g. value.name), JSON.stringify the object, await the promise, or pass it as CHILDREN instead.\nFor anything the kit doesn\'t cover, use raw tags with the app CSS classes (button→\'mini\'/\'mini primary\', input→\'kit-in\', card→\'ncard\', chip→\'pill\', row→\'kit-rowx\', stack→\'kit-stack\') and standard Preact events (onClick; onInput/onChange read `e.target.value`; onKeyDown `e.key`). Custom colours via theme CSS vars (var(--ink)/--mut/--edge/--acc/--panel/--bg) — NEVER hardcoded.\n\nWHAT YOU HAVE:\n- `props.value` — a sample of the object\'s data; render it legibly + structured for THIS shape (messages → a message list w/ sender/text/time; a status record → labelled fields).\n- `props.methods` — the method names you may invoke. NEVER fabricate a method not in this list.\n- `props.call(method, args)` — INVOKE one of the object\'s methods (host-mediated; args is an ARRAY; returns a Promise of the result). Use it for ACTIONS — e.g. a peer with a `send` method → an `input` + a Send `button` whose onClick does `props.call(\'send\', [text])`. This is the ONLY authority you hold; it reaches only THIS object.\n  ⚠️ props.call REJECTS (throws) on a transport/permission failure (e.g. an unreachable peer → "iroh connection cancelled"). ALWAYS try/catch it and REFLECT THE OUTCOME to the user — a "sent ✓" on success, the ERROR MESSAGE on failure (keep the typed text so they can retry). NEVER swallow a failed call with an empty catch: a silent failure makes the widget look broken (the user clicks Send and nothing happens).\n- `props.refresh()` — re-fetch the object\'s data after an action.\n- `endowments.useState`/`useEffect` — local UI state (the input text, a "sent ✓" flash). State is ephemeral UI only.\n\nCONFINEMENT: no DOM/network/fs/caps beyond `props.call` (none else is reachable — that IS the confinement). Reply with ONLY the complete function expression in a single ```js fenced code block — no prose, no `const X =`.';
const rendererMessages = ({ objectName, methods, sample, kind }) => [
  { role: 'system', content: RENDERER_SYS },
  { role: 'user', content: `${kind ? `This is a "${kind}". ` : ''}"${objectName}"${(methods || []).length ? ` exposes methods: ${methods.join(', ')}` : ' is a data record (no callable methods — render props.value)'}.\nA SAMPLE of its data (this is props.value):\n\`\`\`json\n${safeText(sample, 4000)}\n\`\`\`\nWrite the confined renderer for this kind of ${kind || 'object'}.` },
];
// authorRendererWith(llm) → an author that runs through the GIVEN llm (so blossoming can be metered against a
// chat's purse). The default (untolled) author is used only when ensure() is called outside a chat.
const authorRendererWith = llm => async args => {
  let r; try { r = await llm(rendererMessages(args), 'default'); } catch (e) { throw new Error(`renderer agent failed: ${(e && e.message) || e}`); }
  if (r && r.exhausted) throw new Error('this chat’s inference budget is used up — top it up to generate a custom view');
  if (r && r.error) throw new Error(r.error);
  const code = extractJs(String((r && r.text) || '')); if (!code) throw new Error('the renderer agent returned no code');
  return code;
};
const authorRenderer = authorRendererWith(async messages => ({ text: String(await opusComplete({ system: messages[0].content, prompt: messages[1].content, maxTokens: 2000 }) || '') }));
const blossom = makeBlossom({ file: process.env.BLOSSOM_STORE || `${VOICE_STATE_DIR}/blossom.json`, forks, authorRenderer,
  maxConcurrent: Number(process.env.BLOSSOM_MAX_CONCURRENT) || 2, maxTotal: Number(process.env.BLOSSOM_MAX_TOTAL) || 300 });
// Wire the late-bound seam: the chat agent's `customView` tool registers/revises a renderer it AUTHORED
// itself (no hidden LLM — the agent IS the studio, visible in the trace). `current` hands the agent the
// existing source so a revise iterates rather than rewrites.
customView.register = ({ kind, methods, source, objectName, owner }) => blossom.register({ kind: String(kind || ''), methods: Array.isArray(methods) ? methods : [], source, objectName: String(objectName || 'object'), owner: owner || 'root' });
customView.current = ({ kind, methods }) => { const e = blossom.rendererFor(Array.isArray(methods) ? methods : [], String(kind || '')); if (!e || !e.forkId) return null; const r = forks.read(e.forkId, 'root'); return r ? { sig: e.sig, forkId: e.forkId, source: r.source } : null; };
// build a read-only cell source for a shared cell (re-resolved each time from the live HA trie).
const shareCellReader = handle => () => { const ro = haResolveReadOnly(handle); return ro && ro.state ? ro.state() : { state: '(unavailable)' }; };

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
// The entry agent's research() turn-ender hands off to a CONFINED agent with this ring: public, read-only tools
// ONLY — web (fetchUrl + JSON/HTTP APIs), a headless browser (JS-rendered pages), and the research team (search/
// read/synthesize). NO personal data (notes/contacts/home/calendar/files) and NO special/destructive powers, so
// the handoff is safe by construction and needs no approval. (dan: "browser, fetch, research, no personal data.")
const PUBLIC_RESEARCH_RING = ['web', 'browser', 'research'];
const PUBLIC_RESEARCH_SYS = 'You are a confined PUBLIC-RESEARCH agent. Your ONLY tools are public + read-only: fetch web pages and JSON/HTTP APIs (web), a headless browser for JS-rendered pages (browser), and a research team that searches → reads → synthesizes with citations (research). You also have a PRIVATE SCRATCHPAD — fileWrite/fileRead/fileList in your own sandboxed home folder — for working notes, drafts, and intermediate findings; use it freely, it needs no permission. You have NO access to any personal/private data and NO ability to act on anything. Research the question from public sources, then END by calling answer() with a clear, well-written PROSE summary of what you found, with citations — NEVER hand a tool\'s raw JSON object to answer(); write the actual prose reply yourself (e.g. from a research result, use its `report`). If it genuinely cannot be answered from public research, say so plainly.';
const SCOPE_RESEARCH_RING = ['notes', 'reference', 'agents']; // fully-private, read-only, no egress
const SCOPE_RESEARCH_SYS = 'You PLAN a task before its agent is granted powers. Use ONLY your private read-only tools (search notes, consult library/Wikipedia, inspect agent capabilities) for a few round-trips if useful. Then reply with: (a) the concrete STEPS the agent will take to finish end to end, and (b) the capabilities each step needs — being explicit about any step that PRODUCES output (publishing a page/graph/site, writing files, generating an image, posting) and the write-power it requires. PREFER PROGRAMMATIC capabilities over heavyweight ones: anything that can be done programmatically should be — choose `web` (fetchUrl, for pages + JSON/HTTP APIs) over `browser` (a full headless chromium), and only propose `browser` when a page genuinely needs JS rendering or interaction. Do NOT perform the task — just plan it so the right (and cheapest sufficient) powers get granted up front.';
// Two-stage: (1) a confined PRIVATE-domain agent researches the task (real round-trips), then
// (2) a deterministic extraction turns task + research into the minimal power list. The research
// genuinely informs the proposal; stage 2 guarantees a parseable JSON array.
const SCOPE_READ_SAFE = new Set(['homeassistant', 'notes', 'reference', 'research', 'web', 'youtube', 'app']);
const scopePowers = async (task, emit = null) => {
  // CHEAP FIRST PASS (no research agent): one gemma call. If it lands a small, entirely READ-SAFE
  // scope, we're done — skip the heavy private-research pre-step entirely. This is what makes a
  // trivial read ("is the front door open?") fast: no dodecahedron grind, no consent click.
  try {
    const r0 = await callLLM([{ role: 'system', content: SCOPE_SYS }, { role: 'user', content: scopeUser(task) }], 'default');
    const p0 = withOutputPowers(parsePowers(r0.text), task);
    if (p0.length && p0.length <= 2 && p0.every(p => SCOPE_READ_SAFE.has(p))) return { proposed: p0, by: 'gemma-fast', fast: true };
  } catch (e) { log('scope fast', e.message); }
  // Otherwise: the careful two-stage path — private research round-trips THEN extraction.
  let research = '';
  try { const r = await runScheduledAgent({ powers: SCOPE_RESEARCH_RING, prompt: String(task), persona: SCOPE_RESEARCH_SYS, model: 'default', emit }); research = String(r.answer || '').slice(0, 1500); } catch (e) { log('scope research', e.message); }
  const userMsg = scopeUser(task) + (research ? `\n\nPrivate research on this task found:\n${research}` : '');
  try { const r = await callLLM([{ role: 'system', content: SCOPE_SYS }, { role: 'user', content: userMsg }], 'default'); const p = parsePowers(r.text); if (p.length) return { proposed: withOutputPowers(p, task), by: research ? 'research+gemma' : 'gemma' }; } catch (e) { log('scope gemma', e.message); }
  try { const r = await opusComplete({ system: SCOPE_SYS, prompt: userMsg, maxTokens: 300 }); const p = parsePowers(String(r || '')); return { proposed: withOutputPowers(p, task), by: research ? 'research+claude' : 'claude' }; } catch (e) { log('scope claude', e.message); }
  return { proposed: withOutputPowers([], task), by: 'none' };
};

// Per-turn structural guard: a SIMPLE turn (a question/lookup/status check / a few-tool task) should not
// be able to delegate or spawn sub-agents even in a full-power chat. One cheap gemma call classifies the
// turn; if simple, the orchestration verbs are stripped from THIS turn's toolbox. Fail-open (keep them on
// any error) — never block a real task on a flaky classifier.
const ORCH_POWERS = ['delegate', 'roles', 'subagent', 'specialists'];
const ORCH_VERBS = new Set(['delegateTask', 'employ', 'listRoles', 'spawnSpecialist', 'askSpecialist', 'listSpecialists', 'proposeSubAgent']);
// ONE cheap classifier, TWO axes (dan: "have that same pass do the categorization"):
//   SCOPE  = simple|complex → a simple turn can't delegate/spawn (orchestration verbs stripped).
//   FORMAT = rich|text      → a rich turn is nudged to answer with a live/interactive WIDGET.
const TURN_CLASS_SYS = 'Classify a user request to an assistant on TWO axes. Reply with EXACTLY two lowercase words separated by a space: first the SCOPE, then the FORMAT.\nSCOPE = "simple" (a question, lookup, status check, read, or a task one agent finishes in a few tool calls) or "complex" (genuinely multi-stage / large-scope, builds or publishes a lot, or needs several specialized sub-agents).\nFORMAT = "rich" if the answer is best shown as a LIVE or INTERACTIVE widget — anything involving a countdown/timer, a device or entity STATUS, a value that changes over time, a metric, or a set of choices to pick from — else "text".\nExamples: "is the front door open?" => "simple rich"; "set 3 cooking timers" => "simple rich"; "what is the capital of France" => "simple text"; "pick a restaurant for tonight" => "simple rich"; "research X across sources and build a comparison page" => "complex rich".';
const classifyTurn = async text => {
  try {
    const r = await callLLM([{ role: 'system', content: TURN_CLASS_SYS }, { role: 'user', content: String(text || '').slice(0, 600) }], 'default');
    const w = String(r.text || '').toLowerCase();
    return { simple: /\bsimple\b/.test(w) && !/\bcomplex\b/.test(w), rich: /\brich\b/.test(w) && !/\btext\b/.test(w) };
  } catch { return { simple: false, rich: false }; } // fail-open: keep orchestration verbs, no widget nudge
};
// What a rich-format turn appends to the agent's persona so it reaches for a live widget.
const RICH_DIRECTIVE = '\n\nFORMAT HINT: this answer is best shown as a LIVE or INTERACTIVE widget, not just text. PREFER the widget verbs when they fit — showEntityStatus for a device/door/sensor status (it stays LIVE), showCountdowns for timers/cooking steps (each counts down on screen), showChoices for "pick one" answers. Still give a one-line text answer too, but lead with the widget.';

// Voice-note ingest is PROPOSE-ONLY: the agent takes NO actions, it produces proposed action items
// (and, via the scoper, names the capabilities an attenuated agent would need to carry them out).
// A pure completion (no toolbox) → it literally cannot act. gemma → Claude fallback.
// A voice note is often a long, sprawling, stream-of-consciousness monologue that weaves together MANY
// distinct threads. The old prompt asked for a "SHORT" / "concise" list, which collapsed a wide-ranging
// note into a handful of summary bullets (under-decomposition). We now DECOMPOSE: one item per separable
// action/idea/question/decision, granularity scaled to the note's breadth.
const INGEST_PERSONA = 'You received a VOICE NOTE transcript — often a long, sprawling, stream-of-consciousness monologue that weaves together MANY distinct threads. You take NO actions whatsoever; you DECOMPOSE it.\n\nBreak the note into ALL of its distinct, concrete items — one bullet per separable action, idea, question, decision, or thread. Do NOT merge separate ideas into one bullet, and do NOT collapse a wide-ranging note into a few summary points: the NUMBER of items scales with the note\'s breadth — a quick one-topic note yields a bullet or two; a long multi-topic monologue must be decomposed THOROUGHLY into every separable thread, grouped under short **bold** theme headers when there are many. Prefer granular, independently-actionable items over broad ones — err on the side of MORE, finer sub-tasks (nothing distinct should be silently dropped). For any item that needs real work, note that a dedicated attenuated agent could be spun up for it.\n\nOutput ONLY the bulleted decomposition — no preamble, no closing summary.';
const ingestPropose = async transcript => {
  const text = String(transcript || '');
  // A sprawling note needs the stronger reasoner to tease apart its threads — gemma under-decomposes long
  // inputs — so route it to Claude FIRST (with more room), and keep gemma-first (cheap) for short notes.
  const sprawling = text.length > 3000;
  let proposals = '';
  const tryGemma = async () => { try { const r = await callLLM([{ role: 'system', content: INGEST_PERSONA }, { role: 'user', content: text }], 'default'); return String(r.text || '').trim(); } catch (e) { log('ingest gemma', e.message); return ''; } };
  const tryClaude = async () => { try { return String((await opusComplete({ system: INGEST_PERSONA, prompt: text, maxTokens: sprawling ? 3200 : 2000 })) || '').trim(); } catch (e) { log('ingest claude', e.message); return ''; } };
  if (sprawling) proposals = (await tryClaude()) || (await tryGemma());
  else proposals = (await tryGemma()) || (await tryClaude());
  const { proposed } = await scopePowers(text);
  return { proposals: proposals || '(could not analyze the note)', powers: proposed };
};
// The OPERATING PROMPT a proposed attenuated sub-agent would run with. Approval = authorization, so dan
// should be able to READ exactly what the agent is instructed to do (+ what it must NOT touch) BEFORE
// approving it. gemma → Claude fallback; '' if it can't (caller treats absence gracefully).
const SUBAGENT_PROMPT_SYS = 'You write the OPERATING PROMPT for a small, LEAST-AUTHORITY sub-agent that will act on a captured voice note. Given the note, the proposed action items, and the capabilities it will be granted, write the agent\'s first-person instructions: what it should accomplish, how to use ONLY its granted capabilities, what concrete artifact to produce, and an explicit reminder NOT to reach beyond those capabilities (no personal/vault data unless that access was granted). Be concrete and tight — one short paragraph or a few bullet lines. Output ONLY the prompt text the agent would receive — no preamble, no quotes, no meta-commentary.';
const genSubAgentPrompt = async (transcript, proposals, powers) => {
  const u = `Voice note:\n${String(transcript || '').slice(0, 4000)}\n\nProposed action items:\n${String(proposals || '').slice(0, 2000)}\n\nCapabilities it will be granted: ${(powers || []).length ? powers.join(', ') : '(reading only)'}`;
  try { const r = await callLLM([{ role: 'system', content: SUBAGENT_PROMPT_SYS }, { role: 'user', content: u }], 'default'); const t = String(r.text || '').trim(); if (t) return t; } catch (e) { log('subprompt gemma', e.message); }
  try { const t = String((await opusComplete({ system: SUBAGENT_PROMPT_SYS, prompt: u, maxTokens: 700 })) || '').trim(); if (t) return t; } catch (e) { log('subprompt claude', e.message); }
  return '';
};
// Derive a SHORT, descriptive title from a transcript so voice notes/memos are BROWSABLE in the sidebar
// (instead of a "capture-20260621T…" filename or a raw transcript slice). The entry agent labels the note.
// gemma → Claude fallback; returns '' if it can't (callers keep their own fallback).
const TITLE_SYS = 'Write a SHORT, specific title (4 to 8 words, Title Case, no surrounding quotes, no trailing punctuation) that captures what this voice note is about. Output ONLY the title, nothing else.';
const cleanTitle = s => String(s || '').replace(/^["'\s]+/, '').replace(/["'\s.]+$/, '').replace(/\s+/g, ' ').split('\n')[0].slice(0, 72).trim();
const deriveTitle = async transcript => {
  const body = String(transcript || '').slice(0, 4000);
  if (!body.trim()) return '';
  try { const r = await callLLM([{ role: 'system', content: TITLE_SYS }, { role: 'user', content: body }], 'default'); const t = cleanTitle(r.text); if (t) return t; } catch (e) { log('title gemma', e.message); }
  try { const t = cleanTitle(await opusComplete({ system: TITLE_SYS, prompt: body, maxTokens: 40 })); if (t) return t; } catch (e) { log('title claude', e.message); }
  return '';
};
// A passed-in title is descriptive only if it ISN'T a capture/clip filename, a bare timestamp, or a hex id.
// Treat a title as a non-descriptive filename/id ONLY when it really looks machine-generated: a known
// prefix joined by - or _ to a 3+ digit run ("capture-20260621…", "memo_3a4b"), a bare date/timestamp, a
// long hex id, or a media extension. A SPACE separator or a short number ("Note 3 ideas", "Audio 5.1
// setup") is a real human title and is KEPT (the old `[-_ .]?\d` dropped those).
const isFilenameTitle = t => { const s = String(t || '').trim(); return !s || /^(capture|clip|memo|voice|rec|recording|audio|note|new ?chat)[-_]\d{3,}|^\d{4}[-_]?\d\d|^[0-9a-f]{8,}(-[0-9a-f]+)*$|\.(m4a|mp3|wav|txt|md|json)$/i.test(s); };
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
const MEETINGS_DIR = `${VOICE_STATE_DIR}/meetings`;
const SHARED_DIR = `${VOICE_STATE_DIR}/shared-chats`; // Feature B: token → shared chat
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
// Route a live runtime error to the self-improvement loop so the developer agent fixes it automatically
// (e.g. "component source must be a function (ui) => element"). De-duped per process by signature; the
// backlog itself also de-dupes identical goals, so a recurring error files ONE fix task + one feed notice.
const _flaggedErr = new Set();
const flagErrorForFix = async (kind, error, context = '') => {
  try {
    const sig = `${kind}:${String(error).replace(/\s+/g, ' ').slice(0, 90)}`;
    if (_flaggedErr.has(sig)) return false; _flaggedErr.add(sig);
    const goal = `Auto-filed from a live runtime error (${kind}): "${String(error).slice(0, 200)}".${context ? ` ${context}` : ''} Diagnose the root cause in the voice-agent and fix it so this error stops happening; add a test that proves the fix. The suite is the gate.`;
    let r = {}; try { r = addBacklog({ goal, by: 'auto-error-flag', rationale: `Surfaced automatically when this error occurred in the running app (${kind}).` }) || {}; } catch (e) { log('flagErrorForFix addBacklog', e.message); }
    if (r.ok && !r.deduped) await postFeed({ title: '🔧 Error flagged for auto-fix', body: `A "${kind}" error was routed to the self-improvement loop to be fixed automatically:\n\n${String(error).slice(0, 240)}`, status: '🛠️ queued for the developer agent' });
    return true;
  } catch (e) { log('flagErrorForFix', e.message); return false; }
};
// ── per-chat pending COMPONENT ERRORS (the async half of the render-feedback loop; chat 1cbe89a9) ──
// A runtime error a delivered widget throws in the user's browser is posted back (/error/flag with a
// sessionId), queued HERE per chat, and injected into the authoring agent's NEXT turn as system feedback —
// so the agent that shipped the widget hears about the breakage, not just the self-improvement backlog.
// Durable (survives a restart), bounded (≤5 per chat), deduped by error text.
const COMP_ERRS_FILE = path.join(VOICE_STATE_DIR, 'component-errors.json');
let compErrs = {}; try { compErrs = JSON.parse(fs.readFileSync(COMP_ERRS_FILE, 'utf8')) || {}; } catch { /* fresh */ }
const saveCompErrs = () => { try { fs.mkdirSync(VOICE_STATE_DIR, { recursive: true }); fs.writeFileSync(COMP_ERRS_FILE, JSON.stringify(compErrs)); } catch (e) { log('compErrs save', e.message); } };
const pushComponentError = (sid, { error, name }) => {
  const id = String(sid || '').slice(0, 64); if (!id || !error) return false;
  const list = compErrs[id] || (compErrs[id] = []);
  const err = String(error).slice(0, 300);
  if (list.some(x => x.error === err)) return false; // the same error re-thrown on re-render files once
  list.push({ error: err, name: String(name || '').slice(0, 80), at: Date.now() });
  if (list.length > 5) list.splice(0, list.length - 5);
  saveCompErrs();
  return true;
};
const takeComponentErrors = sid => { const id = String(sid || '').slice(0, 64); const list = compErrs[id]; if (!list || !list.length) return []; delete compErrs[id]; saveCompErrs(); return list; };
const SCHED_RUN_BUDGET = Number(process.env.SCHED_RUN_BUDGET_UUSD) || defaultAllowance; // per-run µUSD ceiling — bounds a scheduled run so it can't leak unbounded inference
const runProjectAgent = async (project, agent) => {
  log('scheduled-agent:', project.name, '›', agent.name, '| tools:', (agent.tools || []).join(','));
  // METERED: a scheduled run draws from a bounded per-run purse and its spend is ATTRIBUTED to the
  // originating chat's visible ledger (addSpend) — these timers are never an invisible fund leak.
  const perProvider = {};
  const runModel = agent.model || 'default';
  const purse = makePurse(SCHED_RUN_BUDGET);
  const meteredLLM = makeMeteredLLM({ callLLM, purse, perProvider });
  let out;
  try {
    // purse+perProvider ride into the toolbox ctx so METERED SUB-DELEGATIONS (employ strong-tier,
    // delegateTask, toolsmith) debit THIS run's purse and show up in its attributed spend.
    out = await runScheduledAgent({ powers: agent.tools || [], homeSubkey: project.homeSubkey, prompt: agent.prompt, persona: getPersona(), model: runModel, mode: agent.mode || 'recommend', llm: meteredLLM, budgetLine: budgetLine(purse.balance(), runModel), purse, perProvider });
  } catch (e) { out = { ok: false, error: e.message }; }
  const spent = Object.values(perProvider).reduce((a, b) => a + b, 0);
  // attribute the cost: to the chat that created it (visible in that session's usage), else a per-agent
  // scheduled account — either way it shows up, never silently drains a hidden fund.
  addSpend(agent.originChat || `sched:${agent.id}`, spent);
  const nProp = (out.proposalIds || []).length;
  const now = new Date().toISOString();
  const answer = String(out.ok ? out.answer : `run failed: ${out.error}`);
  const usedTools = out.toolsUsed || [];
  // SPAM GATE: a scheduled run only earns a notification + a sidebar seed-chat
  // when there's something for the operator — proposals raised, or the run
  // failed. A routine no-op (e.g. the self-improvement drainer finding an empty
  // backlog) is recorded ONLY in the agent's run-log (visible in the timer
  // Detail view); it posts no feed notification and spawns no chat. This is what
  // stops the "⏰ … ran" wall with nothing to report.
  // EXCEPTION: an agent flagged `alwaysReport: true` (e.g. the weekly self-eval — an honest
  // "reviewed N chats, zero proposals" IS its deliverable) always lands in the feed + a run chat.
  const reportworthy = nProp > 0 || !out.ok || !!agent.alwaysReport;
  let id = null;
  if (reportworthy) {
    // Persist the run as a reviewable, CONTINUABLE chat (a seed-chat) so the
    // notification deep-links to evidence. #chat=<id> opens it.
    id = `chat-${crypto.randomBytes(6).toString('hex')}`;
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
      body: answer.slice(0, 8000), // store the full run summary so the click-to-expand modal isn't truncated (the card still shows a 400-char preview)
      status: nProp ? `needs your input · ${nProp} proposal(s)` : (out.ok ? 'scheduled report' : 'run failed'), note: `tools: ${(out.grantedPowers || agent.tools || []).join(', ')}`,
      chatId: id, click: `${WEB_URL}/#chat=${id}`, // tapping the notification opens the run
      // deep-link to the TASK behind the run (its config + full run history) — carries only the sched
      // id, a designator; the bell routes it in-app via the viewer's own stored cap (never a swissnum).
      links: [{ label: 'scheduled task', url: `${WEB_URL}/#sched=${agent.id}` }],
    });
  } else {
    log('scheduled-agent: no-op (nothing to report), logged only:', project.name, '›', agent.name);
  }
  projects.recordAgentRun(project.id, agent.id, {
    nextAt: agent.schedule ? projects.computeNextAt(agent.schedule, Date.now()) : null, // event-only agents have no nextAt
    run: { at: now, chatId: id, ok: out.ok, nProp, summary: answer, spentUusd: spent },
  });
  return { ...out, chatId: id };
};

const sessions = new Map(); // sessionId → [{role,content}...]
const lastCtx = new Map(); // sessionId → the exact context bundle last handed to the agent (for the "raw context" viewer)
const runs = new Map();     // sessionId → AbortController (barge-in cancel)
const interjections = makeInterjections(); // sessionId → queued mid-turn user messages (drained at each step boundary)
// sessionId → { state:'running'|'done'|'timedOut'|'exhausted'|'cancelled', node, text, result?, startedAt, at }.
// The agent run lives SERVER-SIDE, decoupled from the request: closing the tab drops the HTTP response but
// NOT the run. We keep its outcome here so a reopened client can RE-ATTACH — render the finished answer, or
// poll until a still-running research completes — instead of losing it. (Cap-hygienic: we store the node
// object, never the swissnum; /chat/result gates reads on that node.) TTL-pruned.
const runResults = new Map();
const RUN_RESULT_TTL = 60 * 60 * 1000; // keep a finished run readable for an hour
const setRunResult = (sid, v) => {
  runResults.set(sid, { ...v, at: Date.now() });
  if (runResults.size > 300) for (const [k, r] of runResults) if (Date.now() - (r.at || 0) > RUN_RESULT_TTL) runResults.delete(k);
};
// SEAMLESS TOP-UP RESUME: when a turn runs out of allowance mid-flight, the reasoning loop hands back its
// in-flight transcript (prior reasoning + tool OUTPUTs). We stash it here keyed by session; a `resume:true`
// /chat after the top-up replays it so the agent CONTINUES from where it stopped instead of re-running every
// step. In-memory + one-shot + TTL-pruned (a restart loses it → the resume cleanly falls back to a full run).
const pendingResumes = new Map(); // sessionId → { transcript:[{role,content}], at }
const RESUME_TTL = 60 * 60 * 1000;
const saveResume = (sid, transcript) => {
  if (!Array.isArray(transcript) || !transcript.length) { pendingResumes.delete(sid); return; }
  pendingResumes.set(sid, { transcript, at: Date.now() });
  if (pendingResumes.size > 200) for (const [k, r] of pendingResumes) if (Date.now() - (r.at || 0) > RESUME_TTL) pendingResumes.delete(k);
};
const consumeResume = sid => { const r = pendingResumes.get(sid); if (!r) return null; pendingResumes.delete(sid); return (Date.now() - (r.at || 0) > RESUME_TTL) ? null : r.transcript; }; // one-shot
// ── live step stream (the inline 3D "pendant"): per-session SSE writers. Carries ONLY
//    tool NAMES + ok/children (no cap, no payload) so the chat can animate the fan-out in
//    real time. Keyed by sessionId; cap-hygiene preserved (the swissnum never rides this URL). ──
const stepStreams = new Map(); // sessionId → Set<res>
// Per-run step BUFFER so a client that JOINS mid-run (reload / open the chat while it's working) can replay
// the trace SO FAR, then stream new steps live — instead of a blank pendant. Bounded; reset at turn start,
// cleared when the run ends (post-run reattach uses the persisted steps via /chat/result).
const stepBuffers = new Map(); // sessionId → [obj]
const STEP_BUF_MAX = 600;
const resetStepBuffer = sid => { stepBuffers.set(sid, []); };
const emitStep = (sid, obj) => {
  let buf = stepBuffers.get(sid); if (!buf) { buf = []; stepBuffers.set(sid, buf); }
  buf.push(obj); if (buf.length > STEP_BUF_MAX) buf.splice(0, buf.length - STEP_BUF_MAX);
  const set = stepStreams.get(sid); if (!set || !set.size) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of set) { try { r.write(line); } catch { /* dropped */ } }
};
// a short "what did this action do" string for inspection — the query/url/path/prompt (no contents, no cap).
const detailFromArgs = (a) => { if (!a || typeof a !== 'object') return ''; const v = a.query || a.url || a.path || a.q || a.prompt || a.task || a.cmd || a.message || a.title || ''; return String(v || '').slice(0, 200); };
// Full-but-bounded text of a tool invocation / result, for the trace's inspectable modal.
// CAP-HYGIENE: never leak a swissnum/secret into the trace, and never ship a base64 blob (e.g. a PNG).
const SECRET_KEY = /swiss|secret|token|password|authorization|api[_-]?key|cookie|\bcap\b/i;
// VALUE-level cap scrub: elide cap-bearing substrings even when they appear in free text (a tool result
// that echoed a #cap link, share token, or a bare 32-hex swissnum). Targets the app's cap SHAPES only, so
// it won't redact 16-hex HA handles or 64-hex hashes. Used by safeText (covers the trace stream + persistence).
const scrubCaps = s => String(s == null ? '' : s)
  .replace(/#cap=[0-9a-fA-F]{16,}/g, '#cap=«redacted»')
  .replace(/#k=[\w-]{16,}/g, '#k=«redacted»')
  .replace(/#agent=[\w-]{8,}/g, '#agent=«redacted»')
  .replace(/\b[0-9a-f]{32}\b/g, '«swissnum»');
// A SAFE descriptive walk for values JSON.stringify chokes on — arrays of REMOTABLES/presences (live ocap
// refs whose proxy traps throw mid-stringify) were falling through to String(v) = "[object Object],…",
// discarding the goods. This never throws and never yields a bare [object Object]: records become
// { key: value } literals, remotables become their alleged interface tag, and per-property access is
// guarded. (Endo's passableAsJustin is the prettier path for true Passables; this also covers plain JS.)
const describeValue = (v, depth = 0, seen = new WeakSet()) => {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v.length > 2000 ? `${v.slice(0, 2000)}…` : v);
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'bigint') return `${v}n`;
  if (t === 'symbol') { try { return v.toString(); } catch { return '«symbol»'; } }
  if (t === 'function') return `[Function ${v.name || 'anon'}]`;
  if (depth > 6) return '…';
  if (seen.has(v)) return '«circular»';
  seen.add(v);
  if (Array.isArray(v)) return `[${v.slice(0, 50).map(x => { try { return describeValue(x, depth + 1, seen); } catch { return '«?»'; } }).join(', ')}${v.length > 50 ? `, …(+${v.length - 50})` : ''}]`;
  let keys = null; try { keys = Object.keys(v); } catch { keys = null; }
  if (keys && keys.length) return `{ ${keys.slice(0, 40).map(k => { if (SECRET_KEY.test(k)) return `${k}: «redacted»`; let val; try { val = describeValue(v[k], depth + 1, seen); } catch { val = '«throws»'; } return `${k}: ${val}`; }).join(', ')}${keys.length > 40 ? ', …' : ''} }`;
  // no enumerable own keys → likely a remotable/presence; surface its interface tag if any
  let tag = '[remotable]'; try { tag = Object.prototype.toString.call(v); if (tag.includes('Alleged')) tag = `[${tag.slice(8, -1)}]`; else tag = '[remotable object — call its .describe()/.help() for its interface]'; } catch { /* */ }
  return tag;
};
const safeText = (v, cap) => {
  const seen = new WeakSet(); let s;
  try {
    s = JSON.stringify(v, (k, val) => {
      if (k && SECRET_KEY.test(k)) return '«redacted»';
      if (typeof val === 'string') return val.length > 4000 ? `${val.slice(0, 4000)}… (+${val.length - 4000} chars)` : val;
      if (val && typeof val === 'object') { if (seen.has(val)) return '«circular»'; seen.add(val); }
      return val;
    }, 2);
    if (s === undefined) s = describeValue(v); // JSON.stringify returns undefined for a bare function/symbol
  } catch { try { s = describeValue(v); } catch { try { s = String(v); } catch { s = ''; } } }
  if (s === undefined || s === null) return '';
  s = String(s).replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, '«base64 data elided»');
  s = scrubCaps(s); // VALUE-level cap-hygiene: a tool whose result echoes a cap must not leak it into the trace/render
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
// The app-shell CSP grants script-src 'unsafe-eval' ONLY when lockdown is on (see FIELD_LOCKDOWN) — SES then
// tames eval, so the relaxation is compensated. We add it to default-src (the script-src fallback) since the
// shell sets no explicit script-src.
const SHELL_SEC = FIELD_LOCKDOWN
  ? { ...SEC, 'content-security-policy': SEC['content-security-policy'].replace("default-src 'self'", "default-src 'self' 'unsafe-eval'") }
  : SEC;
// Serve an HTML app-shell (index.html / apps.html / component-app.html). Under FIELD_LOCKDOWN, stamp the
// <html> element with data-field-lockdown="1" (islands.js reads it to lockdown pre-app.js, no inline script
// needed) and widen the CSP to allow SES's evaluators. OFF = byte-identical to the old serveFile path.
const serveShell = async (res, rel, type) => {
  try {
    let html = await fs.promises.readFile(path.join(HERE, 'public', rel), 'utf8');
    if (FIELD_LOCKDOWN) html = html.replace(/<html(\s|>)/i, '<html data-field-lockdown="1"$1');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store, must-revalidate', ...SHELL_SEC });
    res.end(html);
  } catch { res.writeHead(404, SEC); res.end('not found'); }
};
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
        // A PDF: extract its text right here so the model SEES the content this turn (a PDF in the home
        // folder is otherwise opaque to it — readPdf would be a second round-trip). Inline the extracted
        // text; the file still lives in home for re-reading with readPdf({homePath:…}) if needed.
        const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
        if (isPdf) {
          try {
            const x = await extractPdf(new Uint8Array(bytes), { maxPages: 50, maxChars: 40000 });
            if (x.ok && x.text) {
              const trunc = x.truncatedPages || x.truncatedChars ? ` (showing the first ${x.renderedPages} of ${x.totalPages} pages; truncated)` : '';
              agentAttachments.push({ kind: 'text', name, text: `[PDF "${name}" (${x.totalPages} page(s))${saved ? `, saved to your home folder as ./${saved}` : ''}${trunc}. Extracted text below — re-read with readPdf({homePath:"${saved || name}"}) for more.]\n\n${x.text}` });
              savedRefs.push({ kind: 'file', name, home: saved || undefined });
              continue;
            }
            // fall through to the generic message (e.g. scanned image-only PDF → no text)
            agentAttachments.push({ kind: 'text', name, text: `[A PDF "${name}" (${bytes.length} bytes) was attached${saved ? ` and saved to your home folder as ./${saved}` : ''}, but no text could be extracted (likely a scanned/image-only PDF — there is no OCR). ${x.note || x.error || ''}]` });
            savedRefs.push({ kind: 'file', name, home: saved || undefined });
            continue;
          } catch { /* fall through to generic file handling */ }
        }
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
    if (u.pathname === '/' || u.pathname === '/index.html') return serveShell(res, 'index.html', 'text/html; charset=utf-8');

    // ── Sign in with Bluesky → claim credits ─────────────────────────────────────────────────────────────────
    // client-metadata + jwks serve even before the OAuth dep is installed (they only need the keypair/config), so
    // setup can be staged; login/callback need the dep and report clearly if it's absent.
    if (u.pathname === '/bsky/client-metadata.json' && req.method === 'GET') return json(res, 200, blueskyOAuth.clientMetadata());
    if (u.pathname === '/bsky/jwks.json' && req.method === 'GET') return json(res, 200, blueskyOAuth.jwks());
    if (u.pathname === '/bsky' && req.method === 'GET') {
      const installed = await blueskyOAuth.available().catch(() => false);
      const elig = blueskyEligibility.status();
      const note = u.searchParams.get('status') === 'ineligible'
        ? '<p class="warn">That account isn\'t on the invite list yet. Ask the host to add your Bluesky profile.</p>' : '';
      const body = !installed
        ? '<p class="warn">Sign-in isn\'t switched on yet. (The host still needs to enable Bluesky OAuth.)</p>'
        : !elig.configured
          ? '<p class="warn">Sign-in is up, but the eligibility list isn\'t configured yet.</p>'
          : `${note}<form method="GET" action="/bsky/login"><label>Your Bluesky handle<br><input name="handle" placeholder="you.bsky.social" autocapitalize="none" autocorrect="off" spellcheck="false" required></label><button type="submit">Sign in with Bluesky</button></form>`;
      const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Agent C</title><style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.2rem;color:#e6e6e6;background:#0b0d12}h1{font-size:1.4rem}label{display:block;margin:1.2rem 0 .3rem;font-size:.95rem;color:#9aa}input{width:100%;padding:.7rem;border-radius:.6rem;border:1px solid #333;background:#11141b;color:#e6e6e6;font-size:1rem;box-sizing:border-box}button{margin-top:1rem;padding:.7rem 1.1rem;border:0;border-radius:.6rem;background:#3a7afe;color:#fff;font-size:1rem;cursor:pointer}.warn{color:#ffcf6b}</style><h1>Sign in with Bluesky</h1><p>Claim your space and credits with your Bluesky handle.</p>${body}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC });
      return res.end(page);
    }
    if (u.pathname === '/bsky/login' && req.method === 'GET') {
      const handle = (u.searchParams.get('handle') || '').trim();
      if (!handle) return json(res, 400, { error: 'handle required' });
      try {
        const state = crypto.randomBytes(16).toString('hex');
        const dest = await blueskyOAuth.loginUrl(handle, state);
        res.writeHead(302, { location: dest, 'cache-control': 'no-store', ...SEC });
        return res.end();
      } catch (e) { log('bsky', 'login', e.message); res.writeHead(302, { location: '/bsky?status=error', ...SEC }); return res.end(); }
    }
    if (u.pathname === '/bsky/callback' && req.method === 'GET') {
      try {
        const { did } = await blueskyOAuth.callback(u.searchParams);
        const r = await blueskyClaim.signIn({ did }); // always mints a stable namespace; funds it once iff eligible
        if (r.ok && r.scopedCap) {
          // sign them in to their own namespace (eligible → funded; otherwise zero until they claim). The cap rides
          // the URL FRAGMENT (client-only, as every invite link in this app does) — the app stores it and strips it.
          log('bsky', `sign-in: ${r.eligible ? `eligible${r.granted ? ` (+${r.granted}µUSD)` : ' (already funded)'}` : 'unclaimed — zero balance'}`);
          res.writeHead(302, { location: `${blueskyPublicUrl}/#cap=${r.scopedCap}`, 'cache-control': 'no-store', ...SEC });
          return res.end();
        }
        res.writeHead(302, { location: '/bsky?status=error', 'cache-control': 'no-store', ...SEC });
        return res.end();
      } catch (e) { log('bsky', 'callback', e.message); res.writeHead(302, { location: '/bsky?status=error', ...SEC }); return res.end(); }
    }

    if (u.pathname === '/app.js') return serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/qrcode.js') return serveFile(res, 'qrcode.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/ses.umd.min.js') return serveFile(res, 'ses.umd.min.js', 'text/javascript; charset=utf-8'); // standalone SES shim (taming intact), loaded before the page modules
    if (u.pathname === '/trace.js') return serveFile(res, 'trace.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/pendant.js') return serveFile(res, 'pendant.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/inpaint-island.js') return serveFile(res, 'inpaint-island.js', 'text/javascript; charset=utf-8'); // the confined inpaint island's source (app.js imports it for .toString())
    if (u.pathname === '/three.module.js') return serveFile(res, 'three.module.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/cap-channel.js') return serveFile(res, 'cap-channel.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/trace-app.js') return serveFile(res, 'trace-app.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/widget.js') return serveFile(res, 'widget.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/grain-ui.js') return serveFile(res, 'grain-ui.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/theme.js') return serveFile(res, 'theme.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/fork-model.js') return serveFile(res, 'fork-model.js', 'text/javascript; charset=utf-8');
    if (u.pathname === '/fork-widget.js') return serveFile(res, 'fork-widget.js', 'text/javascript; charset=utf-8'); // mounts a confined fork inline in a chat
    if (u.pathname === '/md.js') return serveFile(res, 'md.js', 'text/javascript; charset=utf-8');
    // the sandboxed component runtime. Served with its OWN no-network CSP (a src= iframe uses its response
    // CSP, NOT the parent's — so the inline runtime runs while all network stays blocked). Loaded with
    // sandbox="allow-scripts" (opaque origin) so it still can't reach the parent DOM/cap.
    if (u.pathname === '/confined.html') {
      try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'" }); res.end(await fs.promises.readFile(path.join(HERE, 'public', 'confined.html'))); }
      catch { res.writeHead(404, SEC); res.end('not found'); }
      return undefined;
    }
    if (u.pathname === '/component-app.js') return serveFile(res, 'component-app.js', 'text/javascript; charset=utf-8');
    if (u.pathname.startsWith('/c/') && req.method === 'GET') return serveFile(res, 'component-app.html', 'text/html; charset=utf-8'); // standalone home of a broken-out component (reads its id from the path)
    // ── islands-as-SPWAs: /apps/<name> serves a standalone host page that mounts island
    //    <name> from THIS origin (no per-app ngrok). The app name is in the path; the cap
    //    rides the #fragment (apps-host.js lifts it out of the address bar). ──
    if (u.pathname === '/kit.css') return serveFile(res, 'kit.css', 'text/css; charset=utf-8');
    if (u.pathname === '/apps-host.js') return serveFile(res, 'apps-host.js', 'text/javascript; charset=utf-8');
    if (u.pathname.startsWith('/apps/') && req.method === 'GET') return serveFile(res, 'apps.html', 'text/html; charset=utf-8');
    // Public descriptive catalog (power → what it does) for UI tooltips. No authority, no secrets.
    if (u.pathname === '/powers') return json(res, 200, { powers: POWER_CATALOG });
    if (u.pathname === '/successes' || u.pathname === '/usecases') { // W6 "Use cases" showcase (tailnet; public bind = operator's call). Own CSP so its inline hero/card script runs.
      try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'" }); res.end(await fs.promises.readFile(path.join(HERE, 'public', 'successes.html'))); }
      catch { res.writeHead(404, SEC); res.end('not found'); }
      return undefined;
    }
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

    // ── agent download links: /dl/<token> streams a file an agent exposed from its OWN home folder via
    //    createDownloadLinkFor(). The token (a 36-hex web-key) IS the credential — like /sites, /uploads. The
    //    target path was jailed + symlink-checked to the agent home at mint time. Served as an ATTACHMENT
    //    under a locked-down CSP, so it can only ever be downloaded, never interpreted as active content. ─
    if (u.pathname.startsWith('/dl/')) {
      const m = /^\/dl\/([0-9a-f]{24,})$/.exec(u.pathname);
      const rec = m && downloadFor(m[1]);
      if (!rec) { res.writeHead(404, SEC); res.end('unknown or expired download'); return; }
      try {
        const st = await fs.promises.stat(rec.path);
        if (!st.isFile()) throw new Error('not a file');
        const safeName = String(rec.name || 'download').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'download';
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename="${safeName}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
        fs.createReadStream(rec.path).pipe(res);
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

    // ── agent SHAPE: the STATIC structural graph of what an agent HOLDS — its powers (each fanning to the
    //    verbs it can call), its persistent specialist sub-agents, and the roles it could employ. This is what
    //    the agent IS (distinct from /chat/steps, which is what it DID). Owner-only; feeds the Settings 🕸️
    //    Agents Granovetter diagram. Names + labels ONLY — never a swissnum/address (cap-hygiene). ──
    if (req.method === 'POST' && u.pathname === '/agent/shape') {
      const { cap, agent } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability — open this app with your #cap= link' });
      if (!node.isRoot) return json(res, 403, { error: 'agent shape is owner-only' });
      const withVerbs = names => (names || []).map(name => ({ name, label: (POWERS[name] && POWERS[name].label) || name, verbs: (POWERS[name] && POWERS[name].verbs) || [] }));
      const rolesFor = held => roleList().map(r => ({ role: r.role, label: r.label, tier: r.tier, writes: r.writes, isolation: r.isolation, blurb: r.blurb, powers: (r.powers || []).filter(p => held.includes(p)) }));
      try {
        const d = await E(node.cap).describe();
        const specialists = (await E(node.cap).listSpecialists()) || [];
        let shape;
        if (agent && agent !== 'field-agent') {
          const s = specialists.find(x => x.id === agent || x.name === agent);
          if (!s) return json(res, 404, { error: 'unknown specialist' });
          shape = { ok: true, kind: 'specialist', label: s.name || s.id, powers: withVerbs(s.powers || []), specialists: [], roles: rolesFor(s.powers || []) };
        } else {
          const held = (d.powers || []).map(p => p.name);
          shape = { ok: true, kind: d.kind, label: d.label, powers: withVerbs(held),
            specialists: specialists.map(s => ({ id: s.id, name: s.name, domain: s.domain || '', powers: s.powers || [], autonomy: s.autonomy || [], spawnedFrom: s.spawnedFrom || null })),
            roles: rolesFor(held) };
        }
        // cap-hygiene guard (defense-in-depth): a shape is names/labels only — refuse if an actual capability
        // LINK value leaked in (a #cap=/#k=/#agent= followed by a hex secret). Matches values, not prose:
        // role blurbs legitimately mention "swissnum"/"#cap" as words, which must NOT trip this.
        if (/#(?:cap|k|agent)=[0-9a-f]{16,}/i.test(JSON.stringify(shape))) return json(res, 500, { error: 'shape contained a capability link — refusing' });
        return json(res, 200, shape);
      } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
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

    // ── eval rating: the OPERATOR records a verdict on a recorded chat/eval run. Owner-only — only the
    //    ROOT cap may write eval ground-truth (an attenuated chat cap must not be able to forge its own
    //    grade). The cap rides in the body; we gate on nodeFor(cap)?.isRoot and land the record 0600 at
    //    eval/results/ratings/<chatId>.json via the shared eval-ratings helper. ──
    if (req.method === 'POST' && u.pathname === '/eval/rate') {
      const { cap, chatId, rating, comment, by } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability — open this app with your #cap= link' });
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'rating an eval run is the owner\'s call — root capability required' });
      try {
        const r = writeRating({ chatId, rating, comment, by: by || nodeFor(cap)?.name || '', dir: ratingsDir(HERE) });
        return json(res, 200, { ok: true, chatId: r.rating.chatId, rating: r.rating.rating, at: r.rating.at });
      } catch (e) { return json(res, 400, { error: String(e && e.message || e) }); }
    }

    // ── live step stream for the inline 3D pendant (SSE). Keyed by sessionId only;
    //    carries tool NAMES + ok/children, never the cap or any payload (cap-hygiene). ──
    if (req.method === 'GET' && u.pathname === '/chat/steps') {
      const sid = String(u.searchParams.get('sid') || 'anon').slice(0, 64);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SEC });
      res.write(': ok\n\n');
      // REPLAY the in-flight trace so far (synchronously, before live wiring → no gap/dup) so a client that
      // joined mid-run sees the whole fan-out, not just steps after it connected.
      const buf = stepBuffers.get(sid); if (buf && buf.length) { for (const obj of buf) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* */ } } }
      let set = stepStreams.get(sid); if (!set) { set = new Set(); stepStreams.set(sid, set); } set.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(hb); set.delete(res); if (!set.size) stepStreams.delete(sid); });
      return undefined; // keep the connection open
    }

    // ── LIVE GRAINS: a widget SUBSCRIBES to named server cells and gets pushed updates (no polling).
    //    POST so the cap rides in the body (cap-hygiene — never a URL/query); the response is a kept-open
    //    SSE stream. Each cell is cap-gated (e.g. ha:<handle> needs the homeassistant power + reach). ──
    // PUBLIC read of a broken-out component for its standalone /c/<id> page: the OWNER (root cap) OR a
    // holder of a valid component-share token bound to THIS id. Returns source + declared cells + name only.
    if (req.method === 'POST' && u.pathname === '/c/ui') {
      const { cap, shareToken, id } = await jsonBody(req);
      const cid = String(id || '');
      const share = shareToken ? componentShares.get(shareToken) : null; // null if expired/revoked/unknown
      const allowed = (share && share.componentId === cid) || nodeFor(cap)?.isRoot;
      if (!allowed) return json(res, 403, { ok: false, error: shareToken ? 'this share link is no longer valid (expired or revoked)' : 'no access to this component' });
      if (share && !nodeFor(cap)?.isRoot) { const ch = componentShares.chargeOpen(shareToken); if (!ch.ok) return json(res, 200, { ok: false, error: ch.error }); } // W3: meter the open (allowance scheme)
      const snap = await componentGit.readAt(cid, 'HEAD');
      if (!snap || !snap.files['component.js']) return json(res, 200, { ok: false, error: 'unknown component' });
      let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ }
      return json(res, 200, { ok: true, id: cid, source: snap.files['component.js'], cells: meta.cells || [], name: meta.name || cid });
    }
    if (req.method === 'POST' && u.pathname === '/cells/subscribe') {
      const { cap, shareToken, cells: ids } = await jsonBody(req);
      // A subscriber is EITHER a normal cap OR a least-authority component-share token. The token grants
      // ONLY its frozen cell list (read-only) — it cannot reach any other cell, hold a power, or open a chat.
      const share = shareToken ? componentShares.get(shareToken) : null; // null if unknown/revoked
      if (!share && !nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      const shareCells = share ? new Set(share.cells.map(c => c.id)) : null;
      const resolve = id => share
        ? (shareCells.has(id) ? { cell: liveCells.cellForReader(id, shareCellReader(share.cells.find(c => c.id === id).handle)) } : { error: 'not in this share' })
        : (id.startsWith('backlog:') ? backlogCellFor(cap, id.slice('backlog:'.length)) : liveCells.cellFor(cap, id)); // backlog:<id> = the object's backlog cell (owner-only; push-fed by the store)
      const list = (Array.isArray(ids) ? ids : []).slice(0, 16).map(String);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SEC });
      res.write(': ok\n\n');
      const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ } };
      const unsubs = [];
      for (const id of list) {
        const { cell, error } = resolve(id);
        if (error || !cell) { send({ id, error: error || 'unavailable' }); continue; }
        unsubs.push(cell.subscribe(value => send({ id, value }))); // pushes the current value immediately + on every change
      }
      let done = false;
      const teardown = () => { if (done) return; done = true; clearInterval(hb); for (const u2 of unsubs) { try { u2(); } catch { /* */ } } try { res.end(); } catch { /* */ } };
      // Heartbeat ALSO re-validates: live entity state (doors/locks) must stop the moment the cap is revoked,
      // rescoped out of reach, OR the share token is revoked — a long-lived push stream can't keep leaking
      // after revocation. A failed write (half-open/dead socket) also ends it.
      const hb = setInterval(() => {
        const gone = share ? !componentShares.get(shareToken) : (!nodeFor(cap) || list.some(id => resolve(id).error)); // resolve (not cellFor) so a backlog: cell re-validates through its own owner gate
        if (gone) return teardown();
        try { if (res.write(': hb\n\n') === false) { /* backpressure ok */ } } catch { teardown(); }
      }, 15000);
      req.on('close', teardown); res.on('close', teardown); res.on('error', teardown);
      try { req.socket.setTimeout(120000, teardown); } catch { /* */ } // half-open guard: no traffic in 2m → drop
      return undefined; // keep open
    }

    // ── mid-turn INTERJECTION: re-steer a RUNNING turn without aborting it. Queued by sessionId (the turn
    //    identity, like /chat/steps) and drained at the next step boundary. Only accepted while a turn is in
    //    flight; folds into the agent's own context (grants no authority), so it rides the sessionId like the
    //    step stream — no cap in the URL (cap hygiene). ──
    if (req.method === 'POST' && u.pathname === '/chat/interject') {
      const { sessionId, text } = await jsonBody(req);
      const sid = String(sessionId || 'anon').slice(0, 64);
      if (!runs.has(sid)) return json(res, 200, { ok: false, error: 'no turn is running for this chat' });
      const ok = interjections.push(sid, text);
      return json(res, 200, { ok, pending: interjections.pending(sid) });
    }
    // The "raw context" viewer. Prefer the LIVE capture (the exact provider `messages` of this chat's most
    // recent LLM call). If there's none (e.g. after a server restart — lastCtx is in-memory), RECONSTRUCT a
    // faithful provider-shaped bundle from the chat's transcript (sent by the client) + the cap's CURRENT
    // persona + tool manifest. Cap-gated; no swissnums (the manifest describes caps by reference).
    if (req.method === 'POST' && u.pathname === '/chat/context') {
      const { sessionId, cap, history, agent } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { ok: false, error: 'a valid capability is required' });
      const sid = String(sessionId || '').slice(0, 64);
      const live = lastCtx.get(sid);
      if (live) return json(res, 200, { ok: true, context: live });
      // Resolve the node/persona the way /chat does, so the preview reflects a chosen SPECIALIST (its
      // confined ring + persona), not just the entry agent.
      let runNode = node, runPersona = getPersona(), runAgentId = 'field-agent';
      if (agent && agent !== 'field-agent' && (node.isRoot || node.powers.has('specialists'))) {
        const spec = specialistFor(agent);
        if (spec) { runNode = spec.node; runPersona = spec.persona || getPersona(); runAgentId = spec.id; }
      }
      const hist = (Array.isArray(history) ? history : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
      // No history (an EMPTY chat) is fine — show the SYSTEM PROMPT this agent will receive given its current
      // permissions (persona + the tool/capability manifest its cap grants), so "{ }" works before any turn.
      let manifest = [];
      try { const built = runNode.toolbox({ chatId: sid, userText: '', emit: () => {}, app: undefined, homeSubkey: null, charge: () => true, purse: makePurse(0), perProvider: {} }); manifest = built.manifest || []; } catch { /* manifest best-effort */ }
      const sysText = `${runPersona || ''}\n\n## Tools / capabilities the agent may call\n${manifest.map(m => `- ${m.name}(${m.args ? Object.keys(m.args).join(', ') : (m.methods || []).join('/')}): ${m.description || ''}`).join('\n')}`;
      return json(res, 200, { ok: true, context: { at: Date.now(), agent: runAgentId, model: 'default', powers: [...runNode.powers], reconstructed: true, preview: !hist.length, messages: [{ role: 'system', content: sysText.slice(0, 24000) }, ...hist] } });
    }
    // ── voice/text turn: the cap decides the agent's reach. No cap → no powers. ──
    if (req.method === 'POST' && u.pathname === '/chat') {
      const { sessionId, text, cap, attachments, model, history: clientHistory, agent, resume } = await jsonBody(req);
      const t = String(text || '').trim();
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability — open this app with your #cap= link to grant the agent powers' });
      // Entrypoint agent: 'field-agent' (Agent C) runs as the cap itself. Any other value names a
      // SPECIALIST to run AS — the turn executes with the specialist's CONFINED ring + persona (not
      // root). Only a cap that OWNS specialists (root, or one holding `specialists`) may act as one.
      let runNode = node, runPersona = getPersona();
      let runAgentId = 'field-agent';
      if (agent && agent !== 'field-agent' && (node.isRoot || node.powers.has('specialists'))) {
        const spec = specialistFor(agent);
        if (spec) { runNode = spec.node; runPersona = spec.persona || getPersona(); runAgentId = spec.id; }
      }
      // Fold this agent's STANDING reference docs into its persona (read once, scope-jailed) — the reusable
      // "documents always on hand" pattern, so e.g. the Dietician already holds the family diet specs and never
      // re-reads them every turn. No-op for an agent with no foldDocs configured.
      try { runPersona = await foldedPersonaFor(runAgentId, runPersona); } catch (e) { log('foldDocs', e.message); }
      const sid0 = String(sessionId || 'anon').slice(0, 64);
      // the chat's home folder: its project's shared folder if filed under one (and owned by THIS cap), else
      // the agent's own home (root → 'root'; an invited user → their cap-<label> via node.homeBinding).
      const turnOwnerKey = runNode.isRoot ? 'root' : 'u:' + crypto.createHash('sha256').update(String(cap || '')).digest('hex').slice(0, 24);
      const maybeProject = projects.projectForChat(sid0);
      const chatProject = (maybeProject && (maybeProject.owner || 'root') === turnOwnerKey) ? maybeProject : null;
      const chatHomeSubkey = chatProject ? chatProject.homeSubkey : (runNode.isRoot ? 'root' : null);
      const { agentAttachments, savedRefs } = await processAttachments(attachments, chatHomeSubkey);
      if (!t && !agentAttachments.length) return json(res, 400, { error: 'empty' });
      const sid = sid0;
      // RESUME a topped-up turn from its saved in-flight transcript (one-shot). Missing (e.g. after a service
      // restart) → null → the runner rebuilds from text+history = a normal full run. So `resume:true` is always
      // safe: it continues the in-flight run when it can, and cleanly re-runs from scratch when it can't.
      const resumeMessages = (resume === true) ? consumeResume(sid) : null;
      // RENDER-FEEDBACK LOOP, async half (chat 1cbe89a9): a widget this chat's agent shipped earlier threw
      // AFTER delivery in the user's browser. Those queued errors are injected into THIS turn as system
      // feedback, so the agent sees its own breakage and repairs it instead of believing its widget works.
      // (The sync half — render-check at authoring time — catches mount errors before delivery.)
      const pendingCompErrs = resumeMessages ? [] : takeComponentErrors(sid);
      const compErrNote = pendingCompErrs.length
        ? `[SYSTEM render feedback — automatic, not typed by the user] Component widget(s) you rendered earlier in this chat FAILED in the user's browser:\n${pendingCompErrs.map(e => `- ${e.name ? `"${e.name}": ` : ''}${e.error}`).join('\n')}\nThe user saw a broken widget. Rebuild it correctly this turn (fix that exact error) or acknowledge the failure — do not claim it works.\n\n`
        : '';
      runs.get(sid)?.abort();
      const ac = new AbortController(); runs.set(sid, ac);
      const startedAt = Date.now();
      // EVERY turn logs its OUTCOME + DURATION on the way out — so a stall is diagnosable from logs alone:
      // a `turn-done … done … 95000ms … opus` line says the turn FINISHED server-side and was slow enough that
      // the inline response likely outran the public proxy's window (→ the client must re-attach to deliver it).
      // A turn that logs `chat:` (start) with no matching `turn-done` is genuinely stuck (no return path hit).
      const PROXY_WINDOW_MS = Number(process.env.PROXY_WINDOW_MS) || 55000; // ~ngrok edge request window
      const turnDone = (outcome, extra = '') => { const ms = Date.now() - startedAt;
        log('turn-done:', sid, '|', outcome, '|', `${ms}ms`, '| model', String(model || 'default'), '| agent', runNode.id,
          ms > PROXY_WINDOW_MS ? '| ⚠️ exceeded proxy window — inline response may not reach the client (client re-attaches via /chat/result)' : '', extra); };
      // mark this session as RUNNING server-side so a reopened tab can re-attach (vs. losing the run).
      setRunResult(sid, { state: 'running', node: runNode, text: t, startedAt });
      if (!resumeMessages) resetStepBuffer(sid); // fresh turn → fresh live-trace buffer (a resume keeps building the same trace)
      // bind the app-state accessor to THIS cap + close over it (the swissnum never enters ctx — cap-hygiene).
      // ROOT-ONLY: the memo/seed/asks/feed stores are GLOBAL, so only the full root agent gets app-state —
      // a shared/sub-agent cap (which holds a confined subset) would otherwise see/mutate everything.
      const boundApp = runNode.isRoot ? harden({ listChats: () => appStore.listChats(cap), readChat: id => appStore.readChat(cap, id), retitle: (id, title) => appStore.retitle(cap, id, title), summary: () => appStore.summary(cap) }) : undefined;
      // the turn's purse + a `charge` that paid connectors (Phase 4) debit market-rate+commission from.
      const purse = purseFor(cap, sid);
      // SUBSCRIPTION AUTO-TOP-UP: if this user granted a recurring MetaMask allowance and their purse is low,
      // refill it from their subscription (within the period cap) BEFORE the turn — so inference + hosting (one
      // unified purse) just keep flowing without a manual payment each time. Best-effort; failure → the normal
      // exhaustion flow still applies. Threshold = the default per-chat allowance (≈ one chat's worth of headroom).
      if (purse.balance() < defaultAllowance && getSubscription(cap, sid)) {
        try { const tu = await autoTopup({ cap, sid, uusd: defaultAllowance }); if (tu.ok) { purse.credit(tu.uusd); log('pay', `subscription auto-top-up +${tu.uusd}µUSD for ${sid} (tx ${tu.ref})`); } } catch (e) { log('pay', 'auto-topup', e.message); }
      }
      const charge = uusd => { const amt = Math.max(0, Math.round(Number(uusd) || 0)); if (!amt) return true; if (!purse.canAfford(amt)) return false; purse.debit(amt); return true; };
      // prepaid inference toll-bridge for THIS turn: ONE perProvider ledger, threaded into the
      // toolbox ctx so the DELEGATED (Opus) path can be metered against the SAME chat purse as callLLM.
      const perProvider = {};
      let { toolbox, manifest } = runNode.toolbox({ chatId: sid, userText: t, emit: ev => emitStep(sid, ev), app: boundApp, homeSubkey: chatProject ? chatProject.homeSubkey : null, charge, purse, perProvider }); // chatId → deep-links; userText → delegates/specialists carry the originating request; emit → pendant stream; app → root state; homeSubkey → project folder; charge → paid-connector billing
      // ONE classifier pass (dan), TWO axes: scope (simple→can't delegate) + format (rich→prefer a widget).
      const cls = t ? await classifyTurn(t) : { simple: false, rich: false };
      // STRUCTURAL no-delegate-for-simple-reads guard: a simple turn can't delegate/spawn even at full power.
      if (cls.simple && ORCH_POWERS.some(p => runNode.powers.has(p))) {
        toolbox = harden(Object.fromEntries(Object.entries(toolbox).filter(([k]) => !ORCH_VERBS.has(k))));
        manifest = manifest.filter(m => !ORCH_VERBS.has(m.name));
        log('turn:', 'simple → stripped orchestration verbs (no delegate/employ/spawn this turn)');
      }
      // RICH format: nudge the agent to answer with a live/interactive widget (the verbs are always available).
      if (cls.rich) { runPersona = `${runPersona || ''}${RICH_DIRECTIVE}`; log('turn:', 'rich → nudged to a live widget'); }
      // Conversation memory: PREFER the client's durable transcript (it survives this service being
      // restarted — the in-memory `sessions` map is volatile and capped, which made the agent forget
      // earlier turns after every deploy). Fall back to the in-process map only if the client sent none.
      const history = (Array.isArray(clientHistory) && clientHistory.length)
        ? clientHistory.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content) })).slice(-24)
        : (sessions.get(sid) || []);
      const images = [];      // data-URLs for live render + this-session 3D trace (stripped before persist)
      const imageUrls = [];    // durable /uploads copies of the SAME images → survive a chat reload
      const proposalIds = [];
      const uiWidgets = []; // live/interactive widget specs the agent emitted (showEntityStatus/showCountdowns/showChoices) → r.ui
      const autoFired = []; // destructive actions that auto-confirmed via a "don't ask again" rule
      const askIds = []; // structured typed questions the agent raised this turn (rendered inline)
      const accessRequests = []; // requestAccess(power) calls → an ACTIONABLE Grant card client-side
      const steps = []; // ordered tool calls this turn; delegateTask nests its sub-agent's tools (sub-branch trees)
      log('chat:', sid, JSON.stringify(t).slice(0, 80), '| model', String(model || 'default'), '| powers:', [...runNode.powers].join(','), agent && agent !== 'field-agent' ? `| as:${agent}` : '', agentAttachments.length ? `| +${agentAttachments.length} attachment(s)` : '');
      // prepaid inference toll-bridge: meter THIS chat's purse; show the agent its budget in-context.
      // (perProvider was declared above so the delegate path and callLLM share one ledger.)
      const meteredLLM = makeMeteredLLM({ callLLM, purse, perProvider });
      // BYO INFERENCE: if this user connected their OWN provider, their turns run on THEIR key + account,
      // UNMETERED (the owner's purse is untouched). Key is read from the vault per turn, never logged/rendered.
      const byo = byoStore.forTurn(cap);
      // Capture the EXACT provider `messages` payload of the MOST RECENT LLM call this turn (system message +
      // alternating user/assistant turns + tool results) — the truth of what the model saw — for the { }
      // viewer. The agent loops (CodeMode), so we overwrite on each call → end on the last one. No swissnums:
      // the system/tool framing describes caps by reference. (content blocks → readable text, bounded.)
      const ctxText = c => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(b => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : b && b.type === 'tool_use' ? `⚙ tool_use ${b.name}(${JSON.stringify(b.input || {}).slice(0, 400)})` : b && b.type === 'tool_result' ? `↳ tool_result: ${ctxText(b.content)}` : JSON.stringify(b).slice(0, 800))).join('\n');
        return JSON.stringify(c).slice(0, 2000);
      };
      const agentLabel = agent && agent !== 'field-agent' ? agent : 'field-agent';
      const capturingLLM = (messages, mdl) => {
        const effModel = byo ? byo.modelId : String(mdl || model || 'default');
        try { lastCtx.set(sid, { at: Date.now(), agent: agentLabel, model: effModel, powers: [...runNode.powers], messages: (Array.isArray(messages) ? messages : []).map(m => ({ role: m.role, content: ctxText(m.content).slice(0, 12000) })) }); } catch { /* viewer is best-effort */ }
        // BYO → straight to callLLM with the user's key + their provider model; the owner's purse stays untouched.
        if (byo) return callLLM(messages, byo.modelId, { apiKey: byo.key });
        return meteredLLM(messages, mdl);
      };
      // Seed the viewer with a SYNTHESIZED provider-shaped bundle (system = persona + tool manifest, then the
      // prior turns, then this user turn) BEFORE the run — so even a turn that errors before its first LLM
      // call still shows context. capturingLLM overwrites it with the REAL provider `messages` once it fires.
      try {
        const sysText = `${runPersona || ''}\n\n## Tools / capabilities the agent may call\n${manifest.map(m => `- ${m.name}(${m.args ? Object.keys(m.args).join(', ') : (m.methods || []).join('/')}): ${m.description || ''}`).join('\n')}`;
        lastCtx.set(sid, { at: Date.now(), agent: agentLabel, model: String(model || 'default'), powers: [...runNode.powers], messages: [
          { role: 'system', content: sysText.slice(0, 24000) },
          ...history.map(h => ({ role: h.role, content: String(h.content).slice(0, 8000) })),
          { role: 'user', content: String(compErrNote + t).slice(0, 8000) }, // incl. injected render feedback — the truth of what the model sees
        ] });
      } catch { /* best-effort */ }
      const TURN_DEADLINE_MS = Number(process.env.TURN_DEADLINE_MS) || 360000; // hard per-turn limit → a LEGIBLE timeout, never a silent stall (the crowdsupply hang)
      let deadlineHit = false; let deadlineT = null;
      let r = await Promise.race([
        AGENT_RUNNER({
        toolbox, manifest, userText: compErrNote + t, history, resumeMessages, attachments: agentAttachments, signal: ac.signal, persona: runPersona, model: byo ? byo.modelId : String(model || 'default'),
        llm: capturingLLM, budgetLine: byo ? `Inference: running on YOUR OWN ${byo.provider} account (${byo.model}) — unlimited; the owner's prepaid allowance does not apply.` : budgetLine(purse.balance(), String(model || 'default')),
        allowResearch: runAgentId === 'field-agent', // the ENTRY agent gets the no-approval public-research handoff (research())
        takeInterjections: () => interjections.take(sid), // mid-turn re-steer: drained + folded into context at each step boundary

        onStep: s => {
          if (s.kind === 'thinking') { emitStep(sid, { t: 'thinking', round: s.round }); return; } // heartbeat before each LLM round → "Thinking…" before any tool fires
          if (s.kind === 'progress') { emitStep(sid, { t: 'progress', text: scrubCaps(String(s.text || '')).slice(0, 280) }); return; } // agent's own updateProgress() ping (cap-scrubbed)
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
          if (rv.widget && typeof rv.widget === 'object' && uiWidgets.length < 8) { const k = JSON.stringify(rv.widget); if (!uiWidgets.some(w => JSON.stringify(w) === k)) uiWidgets.push(rv.widget); } // a live/interactive widget — bounded + de-duped (one entity = one stream, no flood)
          if (rv.autoConfirmed) autoFired.push({ title: rv.title, type: rv.type, ok: rv.fired !== false }); // "don't ask again" fired it
          if (rv.asked && rv.askId) askIds.push(rv.askId); // the agent raised a typed question → render it inline
          if (rv.accessRequest && rv.accessRequest.power) accessRequests.push(rv.accessRequest); // requestAccess → actionable Grant card
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
      // RESEARCH HANDOFF: the entry agent ended its turn with research() — answer this from a CONFINED public-
      // research agent (web/browser/research ONLY; no personal data, no special powers), so it needs NO approval.
      // Its answer becomes the turn's reply. Runs on the same metered purse (no approval ≠ free).
      if (r && r.researching && runAgentId === 'field-agent' && !deadlineHit) {
        emitStep(sid, { t: 'start', name: 'researchOnly', detail: 'public-research handoff (confined: web/browser/research, no personal data)' });
        try {
          const rr = await runScheduledAgent({ powers: PUBLIC_RESEARCH_RING, prompt: t, persona: PUBLIC_RESEARCH_SYS, model: String(model || 'default'), llm: capturingLLM, budgetLine: budgetLine(purse.balance(), String(model || 'default')), emit: s => emitStep(sid, s) });
          const ans = String((rr && rr.answer) || '').trim();
          const kids = ((rr && rr.toolsUsed) || []).map(x => ({ name: x.name || String(x), detail: x.args ? detailFromArgs(x.args) : '', call: x.args ? safeText(x.args, 4000) : '', result: x.result !== undefined ? safeText(x.result, 4000) : '' }));
          steps.push({ name: 'researchOnly', detail: 'public-research handoff', ok: true, ...(kids.length ? { children: kids } : {}) });
          emitStep(sid, { t: 'done', name: 'researchOnly', ok: true, detail: 'public-research handoff', children: kids });
          r = { ...r, answer: ans || 'I handed this to a confined public-research agent, but it returned nothing.', toolsUsed: [...(r.toolsUsed || []), ...((rr && rr.toolsUsed) || [])], researched: true };
        } catch (e) { log('research-handoff', e.message); r = { ...r, answer: `I tried to answer that from public research, but the research agent errored: ${e.message}` }; }
      }
      emitStep(sid, { t: 'end' });
      if (runs.get(sid) === ac) runs.delete(sid);
      interjections.drop(sid); // drop-on-turn-end: any un-drained interjection must not leak into the next turn
      stepBuffers.delete(sid); // run done → drop the live-trace buffer (a post-run reattach uses the persisted steps via /chat/result)
      addSpend(sid, Object.values(perProvider).reduce((a, b) => a + b, 0)); // tally this turn's USED allowance into the leaderboard (covers done/exhausted/timeout — perProvider accrues regardless)
      // WATCHDOG: the turn blew the deadline (or never returned). Surface a LEGIBLE summary instead of a
      // silent cancel — name the steps it ran + the last one (the likely stall), so failures are visible.
      if (deadlineHit || r.timedOut) {
        const names = steps.map(s => s.name).filter(Boolean);
        const last = names[names.length - 1];
        const mins = Math.round(TURN_DEADLINE_MS / 60000);
        turnDone('TIMED_OUT', `${mins}m limit | ${names.length ? `${names.length} step(s) [${names.join(' → ')}], last=${last} (likely stall)` : 'NO steps — stalled before first action'}`); // never a silent stall: name the likely culprit
        const answer = `⚠️ I stopped this run after ${mins} min (the turn time limit). ` + (names.length
          ? `It ran ${names.length} step(s): ${names.join(' → ')}. The last one (${last}) didn't return in time — that's the likely stall.`
          : `It produced no steps — it stalled before the first action (a tool likely hung).`) + ` Tell me to retry, or narrow it to the part that matters.`;
        const toPayload = { answer, steps, toolsUsed: names.map(n => ({ name: n })), agentId: runNode.id, timedOut: true, remaining: purse.balance(), allowance: purse.granted() };
        setRunResult(sid, { state: 'timedOut', node: runNode, text: t, result: toPayload, startedAt, doneAt: Date.now() });
        return json(res, 200, toPayload);
      }
      if (r.cancelled) { turnDone('cancelled', `${steps.length} step(s)`); setRunResult(sid, { state: 'cancelled', node: runNode, text: t, startedAt }); return json(res, 200, { cancelled: true }); }
      // PROVIDER ERROR (429/overload/unreachable) → a RETRYABLE failure, surfaced as `error` (NOT persisted
      // as the answer). The user's message stays; changing the model + retrying produces a clean answer.
      if (r.llmError) { turnDone('llmError', String(r.llmError).slice(0, 120)); setRunResult(sid, { state: 'error', node: runNode, text: t, startedAt, doneAt: Date.now() }); return json(res, 200, { error: r.llmError, llmError: true, retryable: true }); }
      // prepaid allowance spent mid-turn → return a DETERMINISTIC exhausted signal (no model
      // call was made to produce it). The client renders a static Top-up / Abandon card.
      if (r.exhausted) { turnDone('exhausted', `${steps.length} step(s)`); saveResume(sid, r.resumeFrom); const exPayload = { exhausted: true, answer: r.answer || '', remaining: purse.balance(), allowance: purse.granted(), invited: !!inviteAllowances.walletIdFor(cap) }; setRunResult(sid, { state: 'exhausted', node: runNode, text: t, result: exPayload, startedAt, doneAt: Date.now() }); return json(res, 200, exPayload); }
      // history keeps the multimodal user content so a follow-up can still refer to the attached image.
      const next = [...history, { role: 'user', content: buildUserContent(t, agentAttachments) }, { role: 'assistant', content: r.answer }].slice(-12);
      sessions.set(sid, next);
      pendingResumes.delete(sid); // a completed turn supersedes any stale saved resume for this session
      const proposals = proposalIds.map(getProposal).filter(Boolean);
      const asks = askIds.map(getAsk).filter(Boolean); // typed questions raised this turn → rendered inline
      // how the turn ENDED: the CodeMode reply kind (answer/ask/blocked) — a structured signal from the scope
      // function the agent called, not parsed from prose. Carried in the payload for the client + logged below.
      const endKind = r.asking ? 'ask' : r.blocked ? 'blocked' : 'answer';
      const donePayload = { answer: r.answer, endKind, ...(r.asking ? { asking: true } : {}), ...(r.blocked ? { blocked: true } : {}), images, imageUrls, ui: uiWidgets, toolsUsed: r.toolsUsed.map(x => x.name), steps, proposals, autoFired, asks, accessRequests, agentId: runNode.id, attachments: savedRefs, remaining: purse.balance(), allowance: purse.granted(), spent: Object.values(perProvider).reduce((a, b) => a + b, 0), perProvider };
      turnDone(endKind === 'answer' ? 'done' : `done(${endKind})`, `${steps.length} step(s) [${steps.map(s => s.name).filter(Boolean).join(' → ') || 'direct answer'}] | ${Object.values(perProvider).reduce((a, b) => a + b, 0)}µUSD | ${String(r.answer || '').length}ch${proposals.length ? ` | ${proposals.length} proposal(s)` : ''}${accessRequests.length ? ` | ${accessRequests.length} access-request(s)` : ''}${asks.length ? ` | ${asks.length} ask(s)` : ''}`);
      // PERSIST the finished turn so it survives a closed tab — the client re-attaches on reopen.
      setRunResult(sid, { state: 'done', node: runNode, text: t, result: donePayload, startedAt, doneAt: Date.now() });
      // Tab-friendly: ping the user when a SUBSTANTIAL run finishes (long, or it raised questions/actions),
      // so they can ask-and-close and get pulled back. Quick replies don't push (no spam).
      try {
        if (Date.now() - startedAt > 45000 || asks.length || proposals.length || r.asking || r.blocked) {
          const summary = r.asking ? 'needs your answer' : asks.length ? `${asks.length} question(s) need you` : r.blocked ? 'blocked — needs you' : proposals.length ? `${proposals.length} action(s) to confirm` : 'finished';
          const icon = r.asking ? '❓' : r.blocked ? '🚧' : '✅';
          notify({ title: `${icon} ${JSON.stringify(t).slice(1, 41)}… — ${summary}`, message: String(r.answer || '').slice(0, 160), click: `${WEB_URL}/#chat=${sid}`, tags: ['chat'] }).catch(() => {});
        }
      } catch { /* push is best-effort */ }
      return json(res, 200, donePayload);
    }

    // ── MULTI-USER: per-user capabilities (invite-only). /user/init mints a persistent user-cap ONLY for
    //    someone who already holds a valid cap (an invite) — no public/anonymous minting. The user holds their
    //    user-cap (their identity token); /user/{get,prefs,root} are gated by holding it. ──
    if (req.method === 'POST' && u.pathname.startsWith('/user/')) {
      const body = await jsonBody(req);
      if (u.pathname === '/user/init') {
        if (!nodeFor(body.cap)) return json(res, 403, { error: 'open this app with your invite link first' }); // INVITE-ONLY gate
        return json(res, 200, userStore.mint({ prefs: body.prefs || {} }));
      }
      if (u.pathname === '/user/get') { const v = userStore.get(String(body.userCap || '')); return json(res, 200, v ? { ok: true, ...v } : { ok: false, error: 'unknown user-cap' }); }
      if (u.pathname === '/user/prefs') return json(res, 200, userStore.setPrefs(String(body.userCap || ''), body.prefs || {}));
      if (u.pathname === '/user/root') return json(res, 200, userStore.setRoot(String(body.userCap || ''), String(body.root || 'canonical')));
      return json(res, 404, { error: 'unknown /user route' });
    }
    if (req.method === 'POST' && u.pathname === '/cancel') {
      const { sessionId } = await jsonBody(req);
      const sid = String(sessionId || 'anon').slice(0, 64);
      runs.get(sid)?.abort(); runs.delete(sid);
      return json(res, 200, { cancelled: true });
    }
    // RE-ATTACH: a reopened tab asks "what happened (or is happening) on the server for this session?".
    // Lets you ask a question, close the tab, and pick the answer back up — the run never depended on the
    // browser staying open. Cap-gated on the node that ran it (or root); no swissnum is ever stored/returned.
    if (req.method === 'POST' && u.pathname === '/chat/result') {
      const { sessionId, cap } = await jsonBody(req);
      const sid = String(sessionId || 'anon').slice(0, 64);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      const rr = runResults.get(sid);
      if (!rr) return json(res, 200, { state: 'none' });
      if (!(node.isRoot || node === rr.node)) return json(res, 403, { error: 'not your run' });
      const running = rr.state === 'running' && runs.has(sid); // still actually in flight?
      // Log a re-attach that SERVES A FINISHED turn — the smoking gun that the inline response was lost (proxy
      // timeout / dropped tab) and the client had to recover the answer out-of-band. (A `running` poll is silent
      // — it fires every few seconds while watching a live turn; we only want the recovery moment.)
      if (!running && rr.state !== 'running') log('reattach:', sid, '| served', rr.state, rr.doneAt ? `| turn took ${rr.doneAt - rr.startedAt}ms` : '');
      return json(res, 200, { state: running ? 'running' : rr.state, text: rr.text, startedAt: rr.startedAt, ...(rr.result ? { result: rr.result } : {}) });
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
      const { cap, sessionId } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      // `grant` = the public facts the client needs to build a CORRECT ERC-7715 request (the 7715
      // signer = the settlement delegate, the chain, the wei/USD rate). Null when the charge-server
      // is down — the client then refuses the wallet round-trip with a clear message.
      const gp = gatorConfigured() ? await grantParams() : null;
      return json(res, 200, { available: gatorConfigured(), grant: gp, ...subscriptionStatus(cap, String(sessionId || 'anon').slice(0, 64)) });
    }
    if (req.method === 'POST' && u.pathname === '/pay/delegation/grant') {
      const { cap, sessionId, delegation, subscription } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      // Normalize the ERC-7715 wallet response into the {permissionsContext, delegationManager,
      // accountMetadata} triple the settlement service redeems with — and REJECT anything without a
      // permissions context (a grant we could store but never redeem would fail at charge time).
      const norm = normalizeGrant(delegation);
      if (!norm) return json(res, 400, { error: 'no permissions context in the grant — expected an ERC-7715 wallet response' });
      // subscription {periodUsd, periodDays} → a RECURRING allowance the server auto-draws from. The on-chain
      // grant the user signed is periodic; we mirror its terms for our own per-period accounting.
      const sub = subscription && Number(subscription.periodUsd) > 0
        ? { periodUusd: Math.round(Number(subscription.periodUsd) * 1e6), periodMs: Math.max(1, Number(subscription.periodDays) || 30) * 86400000 }
        : null;
      recordDelegation({ cap, sid: String(sessionId || 'anon').slice(0, 64), delegation: norm, now: new Date().toISOString(), subscription: sub });
      return json(res, 200, { ok: true, subscribed: !!sub });
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
      if (amt) { defaultAllowance = amt; saveDefaultAllowance(); } // persist the Settings value across restarts
      return json(res, 200, { defaultAllowance });
    }
    // Settings → Usage: the spend leaderboard (allowance USED per chat, cumulative). Cached server-side.
    if (req.method === 'POST' && u.pathname === '/budget/ledger') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      if (!node.isRoot) return json(res, 403, { error: 'owner only' });
      const ledger = [...spendLedger.entries()].map(([sessionId, spent]) => ({ sessionId, spent })).filter(x => x.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, 20);
      return json(res, 200, { ok: true, ledger });
    }
    // Settings → Timers: jobs AGENTS scheduled (durable timers/intervals via timers.mjs), NOT scheduled agents.
    if (req.method === 'POST' && u.pathname === '/timers/list') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      if (!node.isRoot) return json(res, 403, { error: 'owner only' });
      const timers = (await listTimers()).filter(t => t && t.status === 'active').map(t => ({
        id: t.id, kind: t.kind, label: t.label || '', actionType: (t.action && t.action.type) || '',
        summary: (t.action && t.action.cmd) ? `$ ${String(t.action.cmd).slice(0, 140)}` : String((t.action && (t.action.message || t.action.title)) || '').slice(0, 180),
        everyMs: t.everyMs || 0, nextAt: t.nextAt || t.dueAt || '', created: t.created || '',
      }));
      return json(res, 200, { ok: true, timers });
    }
    if (req.method === 'POST' && u.pathname === '/timers/cancel') {
      const { cap, id } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      if (!node.isRoot) return json(res, 403, { error: 'owner only' });
      return json(res, 200, await cancelTimer(String(id || '')));
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
      // descriptive title: derive one from the transcript unless the caller gave a real (non-filename) title.
      const memoTitle = (isFilenameTitle(title) ? (await deriveTitle(t)) : String(title).trim()) || String(title || '').trim() || t.slice(0, 40) || 'voice memo';
      const run = { id, title: memoTitle, transcript: t, source: String(source || 'memo'), date: new Date().toISOString(),
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
      // IDEMPOTENT: a voice note can be re-POSTed — the ingest driver only marks a note SEEN on a recognized
      // client response, so a slow turn / curl timeout / dual source (iOS Shortcut + NextCloud) re-sends it while
      // the server already created the chat. Dedupe by normalized transcript within a window: a re-POST returns
      // the SAME chat (no duplicate chat, no second analysis, no second push). [fix: two chats per voice note]
      const normTx = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const nt = normTx(t); const DEDUP_MS = 24 * 3600 * 1000;
      try {
        const dup = (await readSeedChats()).find(s => s && s.transcript && (Date.now() - (s.ts || 0)) < DEDUP_MS && normTx(s.transcript) === nt);
        if (dup) { log('ingest dedup → existing', dup.id, JSON.stringify(t).slice(0, 60)); return json(res, 200, { ok: true, chatId: dup.id, deduped: true }); }
      } catch { /* fall through and create */ }
      const id = `chat-${crypto.randomBytes(6).toString('hex')}`;
      log('ingest (propose-only):', id, JSON.stringify(t).slice(0, 80));
      // PROPOSE-ONLY: no tools, no actions — just proposed action items + the capabilities an
      // attenuated agent would need (the scoper). Then push the proposals to dan's phone.
      // analyze the note AND derive a descriptive title concurrently (the entry agent labels the note so
      // it's browsable — not "capture-20260621T…"); keep the caller's title only if it's a real one.
      const { proposals, powers } = await ingestPropose(t);
      // derive a browsable title + the proposed sub-agent's operating prompt concurrently (both depend on the
      // note; the prompt also folds in the proposed actions + powers so you can review what you'd approve).
      const [derivedTitle, proposedPrompt] = await Promise.all([
        isFilenameTitle(title) ? deriveTitle(t) : Promise.resolve(String(title).trim()),
        genSubAgentPrompt(t, proposals, powers),
      ]);
      const _prop = composeDelegateProposal({ proposals, powers, callerPowers: node && node.powers });
      const agentMsg = _prop.message;
      const tr = { answer: agentMsg, toolsUsed: [], steps: [], proposedPowers: powers, proposedPrompt };
      notify({ title: '🎙 Voice note → proposed actions', message: proposals.slice(0, 180), click: `${WEB_URL}/#chat=${id}`, tags: ['memo'] }).catch(e => log('ingest push', e.message));
      const now = new Date().toISOString();
      const seed = { id, title: derivedTitle || String(title || '').trim() || t.slice(0, 48) || 'voice note', ts: Date.now(), source: String(source || 'voice'), transcript: t, proposeOnly: true, proposedPowers: powers, proposedPrompt,
        tx: [{ who: 'you', text: t }, { who: 'agent', text: agentMsg, tools: [], steps: [], proposedPowers: powers, proposedPrompt }],
        versions: [{ v: 0, label: 'original', env: { persona: 'ingest:propose-only' }, ...tr, at: now }] };
      const seeds = await readSeedChats();
      // re-check AFTER the (seconds-long) analysis: a CONCURRENT re-POST of the same note may have created its
      // chat while we were working (the start-of-handler check passed for both). Close that race here.
      const raced = seeds.find(s => s && s.transcript && (Date.now() - (s.ts || 0)) < DEDUP_MS && normTx(s.transcript) === nt);
      if (raced) { log('ingest dedup (raced)', raced.id); return json(res, 200, { ok: true, chatId: raced.id, deduped: true }); }
      seeds.unshift(seed); await writeSeedChats(seeds);
      return json(res, 200, { ok: true, chatId: id, proposedPowers: powers });
    }
    // Re-decompose an already-ingested voice note under the CURRENT ingest prompt/model routing → appends a
    // NEW version (the original is preserved; the version scrubber shows both). Useful after the ingest prompt
    // improves — a note captured under the old, under-decomposing prompt can be regenerated in place.
    if (req.method === 'POST' && u.pathname === '/ingest/regenerate') {
      const { cap, chatId, label } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'root cap required' });
      const seeds = await readSeedChats();
      const seed = seeds.find(s => s && s.id === String(chatId));
      if (!seed || !seed.transcript) return json(res, 404, { error: 'no such ingested chat' });
      const { proposals, powers } = await ingestPropose(seed.transcript);
      const proposedPrompt = await genSubAgentPrompt(seed.transcript, proposals, powers);
      const _prop = composeDelegateProposal({ proposals, powers, callerPowers: node && node.powers });
      const agentMsg = _prop.message;
      const tr = { answer: agentMsg, toolsUsed: [], steps: [], proposedPowers: powers, proposedPrompt };
      seed.versions = seed.versions || [];
      const v = seed.versions.length;
      seed.versions.push({ v, label: String(label || `re-decomposed ${v}`), env: { persona: 'ingest:propose-only' }, ...tr, at: new Date().toISOString() });
      seed.proposedPowers = powers; seed.proposedPrompt = proposedPrompt;
      if (Array.isArray(seed.tx) && seed.tx[1]) seed.tx[1] = { ...seed.tx[1], text: agentMsg, proposedPowers: powers, proposedPrompt };
      await writeSeedChats(seeds);
      log('ingest regenerate', seed.id, `v${v}`, `${proposals.length}c`);
      return json(res, 200, { ok: true, version: v, chatId: seed.id, proposals });
    }
    if (req.method === 'POST' && u.pathname === '/seed-chats/load') {
      const { cap } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'no capability' });
      return json(res, 200, { chats: await readSeedChats() });
    }
    // On-demand: generate (+ cache) the proposed sub-agent's operating prompt for an EXISTING propose-only
    // seed chat that predates prompt-at-ingest. Lets you review the prompt for older voice-note proposals.
    if (req.method === 'POST' && u.pathname === '/seed-chats/gen-prompt') {
      const { cap, id } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'no capability' });
      const seeds = await readSeedChats();
      const s = seeds.find(x => x && x.id === String(id || ''));
      if (!s) return json(res, 404, { ok: false, error: 'no such seed chat' });
      if (s.proposedPrompt) return json(res, 200, { ok: true, prompt: s.proposedPrompt, cached: true });
      const proposals = (s.versions && s.versions[0] && s.versions[0].answer) || (s.tx && s.tx[1] && s.tx[1].text) || '';
      const prompt = await genSubAgentPrompt(s.transcript || (s.tx && s.tx[0] && s.tx[0].text) || '', proposals, s.proposedPowers || []);
      if (!prompt) return json(res, 200, { ok: false, error: 'could not generate a prompt' });
      // cache it back onto the seed (+ its version + agent tx message) so it persists + syncs
      s.proposedPrompt = prompt;
      if (s.versions && s.versions[0]) s.versions[0].proposedPrompt = prompt;
      if (s.tx && s.tx[1]) s.tx[1].proposedPrompt = prompt;
      await writeSeedChats(seeds);
      return json(res, 200, { ok: true, prompt });
    }
    // Throw away a single seed-chat (a scheduled-agent run, viewed from its timer agent's runs folder).
    if (req.method === 'POST' && u.pathname === '/seed-chats/delete') {
      const { cap, id } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'no capability' });
      const seeds = await readSeedChats();
      await writeSeedChats(seeds.filter(s => s && s.id !== String(id || '')));
      return json(res, 200, { ok: true });
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
      // STAGED-BRANCH REVIEW: a self-improve approve/reject is ACTED ON right here — no off-app flush needed.
      // APPROVE → safe-merge the verified branch (post-merge re-verify + auto-revert); REJECT → discard it. The
      // merge can take minutes, so kick it off async, mark the ask done, and post the OUTCOME to the feed; the
      // client gets an immediate ack so the inbox button never hangs.
      if (ask.origin && ask.origin.kind === 'self-improve') {
        const decision = String((ask.answers && ask.answers.decision) || '').toLowerCase() === 'reject' ? 'reject' : 'approve';
        setAskStatus(ask.id, 'done'); // resolve it out of the inbox immediately (the feed carries the outcome)
        log('self-improve review:', ask.id, decision, ask.origin.branch);
        Promise.resolve().then(() => actOnStagedReview({ branch: ask.origin.branch, goal: ask.origin.goal, backlogId: ask.origin.backlogId, decision }))
          .then(r => log('self-improve review done:', ask.id, decision, r && (r.ok ? 'ok' : 'fail'), r && r.reason ? String(r.reason).slice(0, 120) : ''))
          .catch(e => log('self-improve review error:', ask.id, e.message));
        return json(res, 200, { ok: true, ask, selfImprove: decision === 'reject' ? 'discarding' : 'merging' });
      }
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
    if (req.method === 'POST' && u.pathname === '/error/flag') {
      const { cap, kind, error, source, sessionId, name, componentId, forkId } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      if (!error) return json(res, 200, { ok: false });
      const ctx = source ? `The failing component source began: ${String(source).slice(0, 300).replace(/\s+/g, ' ')}` : '';
      const filed = await flagErrorForFix(String(kind || 'runtime'), String(error), ctx);
      // the render-feedback loop's async half: tie the error to ITS chat so the authoring agent hears
      // about the breakage on its next turn (not only the self-improvement backlog).
      const queued = sessionId ? pushComponentError(sessionId, { error, name }) : false;
      if (queued) log('component-error queued for chat', String(sessionId).slice(0, 40), '—', String(error).slice(0, 120));
      // BACKLOG feeder: an error that carries its component/fork IDENTITY also auto-files onto THAT
      // object's own backlog (dedupe-by-count absorbs re-throws) — the object's owner sees it in the
      // edit chat + the live backlog cell, whoever's browser it broke in. Identity is validated against
      // the real stores so an arbitrary id can't grow a phantom backlog.
      const targetId = String(forkId || componentId || '').slice(0, 80);
      let backlogged = false;
      if (targetId && (targetId.startsWith('fork-') ? forks.exists(targetId) : componentGit.exists(targetId))) {
        const b = componentBacklog.add(targetId, { kind: 'error', title: String(error).slice(0, 200), body: source ? `source began: ${String(source).slice(0, 400).replace(/\s+/g, ' ')}` : '', from: 'runtime' });
        backlogged = !!b.ok;
      }
      return json(res, 200, { ok: true, filed, queued, backlogged });
    }
    // ── /render-smell — a confined widget rendered a raw JS value as text ("[object Object]", a leaked
    //    promise, …). The client already showed a readable fallback (safeText); here we route the smell
    //    into the same self-improvement loop so a recurring one gets fixed at the source, and we phrase the
    //    correction the way the authoring agent needs to hear it (which text slot, what to do instead). ──
    if (req.method === 'POST' && u.pathname === '/render-smell') {
      const { cap, smells, name, source } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      const list = Array.isArray(smells) ? smells.filter(s => s && s.tag) : [];
      if (!list.length) return json(res, 200, { ok: false });
      const where = [...new Set(list.map(s => String(s.where || '')).filter(Boolean))].join(', ');
      const feedback = smellFeedback(list, { where });
      // include the offending renderer source so the developer agent can pinpoint the authoring site.
      const ctx = `Component "${String(name || 'component').slice(0, 60)}".${source ? ` Its source began: ${String(source).slice(0, 300).replace(/\s+/g, ' ')}` : ''}`;
      const filed = await flagErrorForFix('render-smell', feedback, ctx);
      return json(res, 200, { ok: true, filed, feedback });
    }
    // ── /gpu/inpaint — FLUX.2 mask inpainting on tinix. Cap-gated (the widget itself holds no cap; the host
    //    mediates this call). Body: { cap, image, mask (data-URL or base64 PNGs), prompt, seed? }. The mask is
    //    WHITE where to regenerate. Returns { ok, dataUrl, info }. ──
    if (req.method === 'POST' && u.pathname === '/gpu/inpaint') {
      const { cap, image, mask, prompt, seed } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { ok: false, error: 'no capability' });
      const toBuf = s => Buffer.from(String(s || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
      try {
        const r = await inpaintGpu(toBuf(image), toBuf(mask), String(prompt || ''), { seed: Number.isFinite(seed) ? Number(seed) : undefined });
        log('inpaint ok', `${r.info.bytes}B`, `${r.info.ms}ms`);
        return json(res, 200, { ok: true, dataUrl: r.dataUrl, info: r.info });
      } catch (e) { log('inpaint failed:', (e && e.message) || e); return json(res, 200, { ok: false, error: (e && e.message) || String(e) }); }
    }
    if (req.method === 'POST' && u.pathname === '/feed/load') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      let entries = []; try { entries = (JSON.parse(await fs.promises.readFile(FEED_FILE, 'utf8')).entries) || []; } catch {}
      let dismissed = []; try { dismissed = (JSON.parse(await fs.promises.readFile(notifStorePath(cap), 'utf8')).dismissed) || []; } catch {}
      const ds = new Set(dismissed);
      const items = entries.slice(0, 80).map(e => ({
        id: e.id, date: e.date, agent: e.agent || '', avatar: e.avatar || '', title: e.title, chatId: e.chatId || null,
        body: String(e.body || '').slice(0, 400), status: e.status || '', note: e.note || '', links: (e.links || []).map(feedLinkHref),
        attention: ATTENTION_RE.test(String(e.status || '')) || e.kind === 'notification', dismissed: ds.has(e.id),
      }));
      return json(res, 200, { items, attentionCount: items.filter(i => i.attention && !i.dismissed).length });
    }
    // FULL text of one notification for the click-to-expand modal (the list /feed/load truncates body for the card).
    if (req.method === 'POST' && u.pathname === '/feed/item') {
      const { cap, id } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      let entries = []; try { entries = (JSON.parse(await fs.promises.readFile(FEED_FILE, 'utf8')).entries) || []; } catch {}
      const e = entries.find(x => x && x.id === String(id || ''));
      if (!e) return json(res, 200, { ok: false });
      return json(res, 200, { ok: true, item: { id: e.id, title: e.title || '', body: String(e.body || ''), status: e.status || '', note: e.note || '', agent: e.agent || '', date: e.date, chatId: e.chatId || null, links: (e.links || []).map(feedLinkHref) } });
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
    // ── CHANGELOG: the human-visible log of self-applied (auto-merged) improvements + one-click revert. ──
    // Root-gated: it exposes what the self-improvement loop shipped to the live branch, and revert is a
    // history-preserving `git revert -m 1` of the recorded merge commit (the safety net for auto-merge).
    if (req.method === 'POST' && u.pathname === '/changelog/load') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'the changelog needs your root capability' });
      let merges = []; try { merges = changelog.list({ limit: 100 }); } catch (e) { log('changelog load', e.message); }
      return json(res, 200, { ok: true, merges });
    }
    if (req.method === 'POST' && u.pathname === '/changelog/revert') {
      const { cap, id } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'reverting a change needs your root capability' });
      try { const r = await changelog.revert({ id: String(id || '') }); return json(res, r.ok ? 200 : 400, r); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }

    if (req.method === 'POST' && u.pathname === '/chats/save') {
      const { cap, data } = await jsonBody(req);
      if (!nodeFor(cap)) return json(res, 403, { error: 'no capability' });
      try {
        const d = (data && typeof data === 'object') ? data : {};
        const LIMIT = 6 * 1024 * 1024;
        let s = JSON.stringify(d);
        let trimmed = 0;
        // NEVER reject the bundle wholesale: that froze the server copy at its last under-limit state, so
        // every chat created afterward silently failed to sync and vanished when another device adopted the
        // stale copy. The chat LIST is tiny + must never be lost; only TRANSCRIPTS bloat. On oversize, drop
        // the OLDEST chats' transcripts (d.chats[0] is newest) until it fits — the full list always saves.
        if (s.length > LIMIT && d.tx && typeof d.tx === 'object') {
          const order = Array.isArray(d.chats) ? d.chats.map(c => c && c.id).filter(Boolean) : Object.keys(d.tx);
          for (let i = order.length - 1; i >= 0 && s.length > LIMIT; i -= 1) { if (d.tx[order[i]]) { delete d.tx[order[i]]; trimmed += 1; s = JSON.stringify(d); } }
          if (s.length > LIMIT) { d.tx = {}; s = JSON.stringify(d); } // pathological huge list → keep the list, drop all tx
        }
        if (s.length > LIMIT) return json(res, 413, { error: 'chat list itself exceeds the size limit' }); // metadata-only is tiny; should never happen
        await fs.promises.mkdir(CHATS_DIR, { recursive: true });
        await withChatLock(cap, () => fs.promises.writeFile(chatStorePath(cap), s)); // serialize vs the agent's retitle
        return json(res, 200, { ok: true, trimmed });
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
      // Any capability (not just root) gets subscribe info — each invited user sees THEIR OWN private topic,
      // and everyone gets the PUBLIC server (publicServer) so they can subscribe off the home network.
      const node = nodeFor((await jsonBody(req)).cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      let cfg = {}; try { cfg = JSON.parse(await fs.promises.readFile(`${HOME}/.config/field-notify/config.json`, 'utf8')); } catch {}
      const topic = node.isRoot ? (cfg.topic || '') : topicForKey(node.id); // root keeps its topic; each guest gets its own
      return json(res, 200, { server: cfg.publicServer || cfg.server || '', topic });
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
      inviteAllowances.adopt(cap, out.swiss); // an allowance-funded member's sub-chat spends the member's wallet (no-op otherwise)
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, name: out.name });
    }
    if (req.method === 'POST' && u.pathname === '/scope/mint') {
      const { cap, powers, label } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'minting a scoped cap needs your root capability' });
      const out = mintScopedCap({ powers: Array.isArray(powers) ? powers : [], label });
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, name: out.name });
    }
    // INVITE a new user (Phase 1): mint a persisted, confined starter cap. Default ring = least-privilege
    // stateless/read-only tools + the `contact` back-channel; the invitee can `requestAccess` for more.
    // `allowanceUusd` (optional, User Agency): the invite CARRIES a usage-credit allowance — the owner's
    // invite wallet is DEBITED it (conservation; refuse when it can't cover) and the member's shared
    // zero-seeded wallet is CREDITED it. When it runs dry the member tops up with THEIR OWN payment
    // (Stripe / MetaMask delegation) — the exhaustion card is the storefront.
    if (req.method === 'POST' && u.pathname === '/invite') {
      const { cap, powers, label, allowanceUusd } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'inviting needs your root capability' });
      const STARTER = STARTER_RING; // least-privilege starter ring (single source: system-map.mjs)
      const ring = (Array.isArray(powers) && powers.length) ? powers.filter(p => ALL_POWERS.includes(p)) : STARTER;
      const uusd = Math.max(0, Math.round(Number(allowanceUusd) || 0));
      let grant = null;
      if (uusd > 0) { grant = grantFromRootWallet(uusd); if (!grant.ok) return json(res, 402, { error: grant.error, walletRemaining: grant.remaining }); }
      const out = mintScopedCap({ powers: ring, label: label || 'guest' });
      if (grant) { grant.deposit(out.swiss); log('invite:', `funded "${label || 'guest'}" with ${uusd}µUSD from the invite wallet (${grant.remaining}µUSD left)`); }
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, starter: STARTER, allowanceUusd: uusd, walletRemaining: rootWallet().balance() });
    }
    // The owner's invite wallet — the CONSERVED source of invite-carried allowances. Root-gated: fund()
    // is the only balance-increaser anywhere in the invite-credit economy (members top up by PAYING).
    if (req.method === 'POST' && u.pathname === '/wallet/status') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'the invite wallet is the owner\'s' });
      const w = rootWallet();
      return json(res, 200, { ok: true, remaining: w.balance(), granted: w.granted(), invites: inviteAllowances.list().map(x => ({ label: x.label, granted: x.granted, members: x.members, createdAt: x.createdAt })) });
    }
    if (req.method === 'POST' && u.pathname === '/wallet/fund') {
      const { cap, amount } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'funding the invite wallet needs your root capability' });
      const w = rootWallet(); w.credit(Math.max(0, Math.round(Number(amount) || 0)));
      return json(res, 200, { ok: true, remaining: w.balance(), granted: w.granted() });
    }
    // BYO INFERENCE: any holder of a cap connects THEIR OWN anthropic/openrouter account (key → vault, never
    // echoed). Their turns then run on it, unmetered. /status never returns the key (only whether one is set).
    if (req.method === 'POST' && u.pathname.startsWith('/byo')) {
      const body = await jsonBody(req);
      if (!nodeFor(body.cap)) return json(res, 403, { error: 'no capability' });
      if (u.pathname === '/byo/status') return json(res, 200, byoStore.status(body.cap));
      if (u.pathname === '/byo/set') return json(res, 200, byoStore.set(body.cap, { provider: body.provider, model: body.model, key: body.key }));
      if (u.pathname === '/byo/clear') return json(res, 200, byoStore.clear(body.cap));
      return json(res, 404, { error: 'unknown byo route' });
    }
    // CLIPS ("promote on attention"): a message (or highlighted segment) → a shareable PAGE on demand. Any
    // cap-holder clips their OWN content; the clip is owner-keyed + revocable. The client sends the segment's
    // sanitized markdown HTML; we DEFENSIVELY strip any scripts/handlers (the /sites CSP is permissive) before
    // hosting it. The /sites token IS the share link (copy/QR, never rendered).
    if (req.method === 'POST' && u.pathname.startsWith('/clip')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node) return json(res, 403, { error: 'no capability' });
      const ownerKey = node.isRoot ? 'root' : 'u:' + crypto.createHash('sha256').update(String(body.cap || '')).digest('hex').slice(0, 24);
      if (u.pathname === '/clip/create') {
        const scrub = h => String(h || '').slice(0, 250000)
          .replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<\/?(?:script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
          .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1="#"');
        if (!body.html || !String(body.html).trim()) return json(res, 400, { error: 'nothing to clip' });
        const r = await publishClip({ ownerKey, title: body.title, html: scrub(body.html) });
        return json(res, r.ok ? 200 : 400, r);
      }
      if (u.pathname === '/clip/list') return json(res, 200, { clips: listClips(ownerKey) });
      if (u.pathname === '/clip/revoke') return json(res, 200, revokeClip({ ownerKey, token: body.token }));
      return json(res, 404, { error: 'unknown clip route' });
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

    // ── /gauntlet — the FEEDBACK-LOOPS view (owner-only): the dev agent's checks & balances surfaced as
    //    GATE-LANES in the propagator-gate model (each gate reads the action's cells → a verdict; the action
    //    proceeds only while the verdict holds). Read-only "surface what exists": the real 4-discipline review
    //    panel findings + the FAPO verify/auto-merge/re-verify/auto-revert ledger.
    if (req.method === 'POST' && u.pathname === '/gauntlet') {
      const { cap } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { ok: false, error: 'the feedback-loops view is owner-only' });
      const reviewed = customTools.listAll().filter(t => t.review);
      const byDisc = {};
      for (const t of reviewed) for (const f of (t.review.findings || [])) { (byDisc[f.discipline] || (byDisc[f.discipline] = [])).push({ tool: t.name, severity: f.severity, report: String(f.report || '').slice(0, 220), at: t.review.ranAt || '' }); }
      const dGate = (id, name, checks) => ({ id, name, stage: 'post-produce', reads: 'the submitted code (a cell)', verdictCell: 'admission verdict', policy: 'advisory + admission gate', checks, flagged: (byDisc[id] || []).length, findings: (byDisc[id] || []).slice(-4).reverse() });
      const disciplineLane = {
        action: 'Admit an agent-authored component / tool',
        cell: 'the submitted code',
        note: `${reviewed.length} submission(s) reviewed so far`,
        gates: [
          dGate('ocapReviewer', 'ocap discipline', 'designation by reference (not forgeable strings) · least authority · no swissnum to DOM/URL/log · attenuation + revocation'),
          dGate('propagatorReviewer', 'propagator discipline', 'state in CELLS not components · stateless/memoryless propagators · reactive wiring (not imperative re-render) · no over-wiring (= over-authority)'),
          dGate('capHygieneReviewer', 'cap-hygiene', 'never render/persist a swissnum or #cap · copy + on-demand QR hand-offs · strip the cap from the address bar'),
          dGate('sharingReviewer', 'sharing & distribution', 'attenuated + revocable shares · allowance metering · social-collateral end-user gate'),
        ],
      };
      let merges = [];
      try { merges = ((JSON.parse(fs.readFileSync(process.env.AUTO_MERGE_LEDGER || `${STATE_DIR}/auto-merge-ledger.json`, 'utf8')).merges) || []).slice(-8).reverse().map(m => ({ goal: m.goal, mergeCommit: String(m.mergeCommit || '').slice(0, 8), mergedAt: m.mergedAt, rolledBack: !!m.rolledBack })); } catch { /* no ledger yet */ }
      const fapoLane = {
        action: 'Self-improve the system (FAPO loop)',
        cell: 'the worktree diff + the test outcome',
        note: merges.length ? `${merges.length} recent auto-merge(s)` : 'no auto-merges yet',
        gates: [
          { id: 'verify', name: 'Verify (isolated checkout)', stage: 'pre-merge', reads: 'the diff', verdictCell: 'green/red', policy: 'BLOCK', checks: 'the success command / full test suite must pass in a CLEAN isolated checkout — an unverified change never lands' },
          { id: 'merge', name: 'Flag-gated auto-merge', stage: 'merge', reads: 'verify verdict + the auto-merge flag', verdictCell: 'merged?', policy: 'gate', checks: 'only a verified-green, conflict-free change merges — as a --no-ff (one revertible merge commit) — and only if auto-merge is enabled' },
          { id: 'reverify', name: 'Re-verify (post-merge)', stage: 'post-merge', reads: 'the live branch', verdictCell: 'still-green?', policy: 'BLOCK', checks: 'tests re-run on the LIVE branch after the merge — catches a change that interacts badly with concurrent work' },
          { id: 'revert', name: 'Auto-revert', stage: 'post-merge', reads: 're-verify verdict', verdictCell: 'reverted?', policy: 'REVERT', checks: 'a post-merge regression auto-reverts the merge commit + records it in the ledger (rollback = one git revert)' },
        ],
        recent: merges,
      };
      return json(res, 200, { ok: true, agent: 'developer (Blacksmith) + self-improver',
        model: 'Propagator-gate: each check is a propagator wired to the action’s cells — it reads them and writes a verdict; the action proceeds only while the verdict holds. Adding a check = wiring one more propagator (no change to the action). pre/per/post is just WHICH cell the gate reads.',
        lanes: [disciplineLane, fapoLane] });
    }

    // ── /blossom/* — the eager "render an island per object interface" loop (owner's renderer library).
    if (req.method === 'POST' && u.pathname.startsWith('/blossom/')) {
      const body = await jsonBody(req);
      if (!nodeFor(body.cap)?.isRoot) return json(res, 403, { ok: false, error: 'the renderer-blossom library is owner-only' });
      // ensure: SPOT an object → blossom a renderer for its interface signature (fire-and-forget; poll). The
      // LLM authoring is METERED against the TRIGGERING CHAT's purse (the toll-bridge) — blossoming draws from
      // that chat's inference budget, so the spend is visible + bounded by the same per-chat allowance.
      if (u.pathname === '/blossom/ensure') {
        const sid = String(body.sessionId || 'anon').slice(0, 64);
        const chatLlm = makeMeteredLLM({ callLLM, purse: purseFor(body.cap, sid), perProvider: {} });
        return json(res, 200, { ok: true, entry: await blossom.ensure({ methods: body.methods || [], kind: String(body.kind || ''), objectName: String(body.name || 'object'), sample: body.sample, owner: 'root', author: authorRendererWith(chatLlm) }) });
      }
      if (u.pathname === '/blossom/for') return json(res, 200, { ok: true, entry: blossom.rendererFor(body.methods || [], String(body.kind || '')) || { status: 'none', sig: blossom.sigOf(body.methods || [], String(body.kind || '')) } });
      if (u.pathname === '/blossom/source') { const e = blossom.bySig(body.sig); if (!e || e.status !== 'ready' || !e.forkId) return json(res, 200, { ok: false, error: 'no ready renderer for this signature' }); const src = forks.source(e.forkId, 'root'); return json(res, 200, src ? { ok: true, sig: e.sig, forkId: e.forkId, source: src } : { ok: false, error: 'renderer fork missing' }); }
      // register: install a renderer whose SOURCE is provided directly (no LLM) — the HTTP primitive behind the
      // chat agent's `customView` tool. Create-or-revise by signature.
      if (u.pathname === '/blossom/register') return json(res, 200, blossom.register({ kind: String(body.kind || ''), methods: body.methods || [], source: String(body.source || ''), objectName: String(body.name || 'object'), owner: 'root' }));
      if (u.pathname === '/blossom/list') return json(res, 200, { ok: true, renderers: blossom.list(), stats: blossom.stats() });
      if (u.pathname === '/blossom/forget') return json(res, 200, { ok: blossom.forget(String(body.sig || '')) });
      return json(res, 404, { ok: false, error: 'unknown blossom route' });
    }

    // ── /forks/* — user-owned forks of confined Preact components (fork→edit→re-share, in-tree/no-iframe).
    // Available to ANY cap-holder (not root-only): owner is derived from the cap (forkOwnerOf). The one
    // exception is /forks/open (the share redemption) — token-gated, NO cap, vends only the source to render.
    if (req.method === 'POST' && u.pathname.startsWith('/forks/')) {
      const body = await jsonBody(req);
      // share redemption: a recipient with a token gets just the source (metered). Adopt+edit = /forks/create.
      if (u.pathname === '/forks/open') {
        const o = forks.openShare(String(body.token || ''));
        if (o.ok) {
          const ap = distTrust.approvalFor(o.id, o.source); // Phase 5: distribution-trust status of the served version
          o.distribution = ap;
          // END-USER GATE: a forEndUsers share NEVER vends source a reviewer hasn't approved — the source is
          // withheld (blanked) and the recipient is told it's pending review. (A normal share still renders;
          // the distribution status is advisory there — the widget shows a trust badge.)
          if (o.forEndUsers && !ap.approved) { o.source = ''; o.gated = true; o.note = 'This shared component is pending a distribution reviewer’s approval.'; }
        }
        return json(res, 200, o);
      }
      // Phase 4 recipient-side, token-gated (NO cap): try-on / accept / auto-accept an owner's newer version + read the owner's inbox.
      if (u.pathname === '/forks/upgrade/preview') return json(res, 200, forks.previewUpgrade(String(body.token || '')));
      if (u.pathname === '/forks/upgrade/accept') return json(res, 200, forks.acceptUpgrade(String(body.token || '')));
      if (u.pathname === '/forks/upgrade/auto') return json(res, 200, forks.setAutoAccept(String(body.token || ''), !!body.on));
      if (u.pathname === '/forks/inbox') return json(res, 200, forks.shareInbox(String(body.token || '')));
      // ⚑ ADD-ONLY backlog filing by a SHARE RECIPIENT (token, NO cap): holding a share token grants
      // exactly one extra verb — file an issue/request on the fork's backlog. NO read comes with it:
      // the token cannot list, ack, or subscribe (the backlog cell is owner-only). `from` = an opaque
      // hash-prefix tag of the token, so the owner sees WHICH share filed without ever seeing the token.
      if (u.pathname === '/forks/backlog/report') {
        const st = forks.shareTarget(String(body.token || ''));
        if (!st.ok) return json(res, 403, { ok: false, error: st.error });
        const r = componentBacklog.add(st.forkId, { kind: body.kind === 'request' ? 'request' : 'issue', title: body.title, body: body.body, from: backlogOriginOf(body.token) });
        return json(res, 200, r.ok ? { ok: true, deduped: !!r.deduped } : r); // add-only: no item list/state echoes back
      }
      const owner = forkOwnerOf(body.cap);
      if (!owner) return json(res, 403, { ok: false, error: 'a valid capability is required to own forks' });
      if (u.pathname === '/forks/create') {
        const r = forks.create({ source: body.source, name: body.name, baseId: body.baseId || null, owner });
        // creating the fork IMPLICITLY endows its creator with the backlog owner facet — the empty
        // backlog exists from birth, keyed by the same id the owner already designates the fork by.
        if (r.ok) componentBacklog.ensure(r.id);
        return json(res, 200, r);
      }
      if (u.pathname === '/forks/list') return json(res, 200, { ok: true, forks: forks.list(owner) });
      if (u.pathname === '/forks/read') { const r = forks.read(String(body.id || ''), owner); return json(res, 200, r ? { ok: true, ...r } : { ok: false, error: 'unknown fork (or not yours)' }); }
      if (u.pathname === '/forks/history') { const h = forks.history(String(body.id || ''), owner); return json(res, 200, h ? { ok: true, versions: h } : { ok: false, error: 'unknown fork (or not yours)' }); }
      if (u.pathname === '/forks/revert') return json(res, 200, forks.revert(String(body.id || ''), body.version, owner));
      if (u.pathname === '/forks/remove') return json(res, 200, { ok: forks.remove(String(body.id || ''), owner) });
      if (u.pathname === '/forks/share') return json(res, 200, forks.share({ id: String(body.id || ''), owner, charge: body.charge || {}, forEndUsers: !!body.forEndUsers }));
      if (u.pathname === '/forks/share/revoke') return json(res, 200, { ok: forks.revokeShare(String(body.token || ''), owner) });
      if (u.pathname === '/forks/notify') return json(res, 200, forks.notifyRecipients(String(body.id || ''), owner, String(body.message || ''))); // owner → recipients' inboxes ("I changed X — update?")
      // ── Phase 5 distribution-trust (social collateral). grant/revoke a reviewer; approve/unapprove a fork
      //    VERSION for end-user distribution; query the graph + a fork's status. Owner = the caller's id.
      if (u.pathname === '/forks/review/reviewers') return json(res, 200, { ok: true, reviewers: distTrust.reviewers(), me: owner, amReviewer: distTrust.isReviewer(owner) });
      if (u.pathname === '/forks/review/grant') return json(res, 200, distTrust.grantReviewer(owner, String(body.reviewerId || '')));
      if (u.pathname === '/forks/review/revoke-reviewer') return json(res, 200, distTrust.revokeReviewer(owner, String(body.reviewerId || '')));
      if (u.pathname === '/forks/review/approve' || u.pathname === '/forks/review/unapprove') {
        if (!distTrust.isReviewer(owner)) return json(res, 200, { ok: false, error: 'you are not a distribution reviewer' });
        // body.source (an explicit version, e.g. from a share you reviewed) takes precedence; otherwise the
        // owner's CURRENT fork source. Precedence matters: approving/revoking a SPECIFIC past version must
        // target that version, not whatever the fork has since been edited to.
        const id = String(body.id || ''); const r = forks.read(id, owner); const src = body.source || (r && r.source);
        if (!src) return json(res, 200, { ok: false, error: 'no source to review (own the fork, or pass the reviewed source)' });
        return json(res, 200, u.pathname === '/forks/review/approve' ? distTrust.approve(owner, id, r ? r.version : (body.version || null), src) : distTrust.revokeApproval(owner, id, src));
      }
      if (u.pathname === '/forks/review/status') { const id = String(body.id || ''); const r = forks.read(id, owner); const src = (r && r.source) || body.source; return json(res, 200, { ok: true, status: src ? distTrust.approvalFor(id, src) : { approved: false }, amReviewer: distTrust.isReviewer(owner) }); }
      if (u.pathname === '/forks/shares') return json(res, 200, { ok: true, shares: forks.sharesFor(String(body.id || ''), owner) });
      // ── the fork's BACKLOG, owner facet (implicitly endowed at creation): read/list, ack/done, and
      //    file the owner's own items. Gated by the SAME ownership check every other fork verb uses.
      //    The live view is the `backlog:<id>` cell on /cells/subscribe — these are the write verbs.
      if (u.pathname === '/forks/backlog' || u.pathname === '/forks/backlog/ack' || u.pathname === '/forks/backlog/add') {
        const id = String(body.id || '');
        if (!forks.get(id, owner)) return json(res, 200, { ok: false, error: 'unknown fork (or not yours)' });
        if (u.pathname === '/forks/backlog/ack') return json(res, 200, componentBacklog.setStatus(id, body.itemId, String(body.status || 'done')));
        if (u.pathname === '/forks/backlog/add') return json(res, 200, componentBacklog.add(id, { kind: body.kind, title: body.title, body: body.body, from: 'owner' }));
        return json(res, 200, { ok: true, items: componentBacklog.list(id, { status: body.status ? String(body.status) : undefined }), counts: componentBacklog.counts(id) });
      }
      if (u.pathname === '/forks/edit') {
        const id = String(body.id || '');
        // RENDER SMOKE (chat-1cbe89a9 loop): a fork edit must MOUNT before it lands. Without this, a broken
        // source was committed + applied live, confineComponent swallowed the throw (renders null), and the
        // author never saw it — a silently blank widget. The error now comes back as the edit's result and
        // the broken version is NEVER saved (the prior good version stays live).
        const smokeFork = async src => { const s = await renderCheck(src, { kind: 'fork' }); return s.ok ? null : { ok: false, error: `the edited fork FAILED a real render check — the edit was NOT saved (the previous version stays live). It would break with: ${s.error}. Fix the source and edit again.` }; };
        // Direct source edit (deterministic; used by fork-from-existing + tooling), OR an agent edit: the
        // owner's micro-agent rewrites the source from a prompt, scoped to JUST this fork's (endowments,props)=>vnode.
        if (typeof body.source === 'string') { const bad = await smokeFork(body.source); if (bad) return json(res, 200, bad); return json(res, 200, forks.edit(id, body.source, owner, 'edit')); }
        const cur = forks.source(id, owner);
        if (cur === null) return json(res, 200, { ok: false, error: 'unknown fork (or not yours)' });
        let out; try { out = String((await opusComplete({ system: FORK_EDIT_SYS, prompt: `Current fork source:\n\`\`\`js\n${cur}\n\`\`\`\n\nRequested change: ${String(body.prompt || '')}`, maxTokens: 4000 })) || ''); }
        catch (e) { return json(res, 200, { ok: false, error: `edit agent failed: ${(e && e.message) || e}` }); }
        const code = extractJs(out); if (!code) return json(res, 200, { ok: false, error: 'the edit agent returned no code' });
        const bad = await smokeFork(code); if (bad) return json(res, 200, bad);
        return json(res, 200, forks.edit(id, code, owner, String(body.prompt || 'agent edit').slice(0, 60)));
      }
      // P2-for-forks: the CONVERSATIONAL edit loop for a live fork — the same REAL agent loop components
      // get via /components/edit-chat, scoped (by toolbox construction) to ONE fork: readForkSource() +
      // editFork({prompt}) are its ENTIRE authority (lexical confinement; the owner gate is the cap above,
      // so it can only ever touch THIS owner's fork). It converses: reads the source, asks ONE clarifying
      // question if needed (ask()), else edits + reports (answer()). The client maintains the thread.
      if (u.pathname === '/forks/edit-chat') {
        const id = String(body.id || ''); const message = String(body.message || '').trim();
        if (!message && !body.contextPreview) return json(res, 200, { ok: false, error: 'empty message' });
        const rec = forks.read(id, owner);
        if (!rec) return json(res, 200, { ok: false, error: 'unknown fork (or not yours)' });
        const name = rec.name || id;
        // the fork's OPEN BACKLOG rides into the editor agent's context (same source of truth as the
        // backlog:<id> cell) — "discuss editing it" arrives already informed by its filed issues/errors.
        const blNote = componentBacklog.contextNote(id, name);
        const history = (Array.isArray(body.history) ? body.history : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) })).slice(-16);
        let edited = null;
        const toolbox = {
          readForkSource: { run: async () => { const src = forks.source(id, owner); return src === null ? { ok: false, error: 'unknown fork (or not yours)' } : { ok: true, name, source: src }; } },
          editFork: { run: async ({ prompt } = {}) => {
            const cur = forks.source(id, owner);
            if (cur === null) return { ok: false, error: 'unknown fork (or not yours)' };
            let out2; try { out2 = String((await opusComplete({ system: FORK_EDIT_SYS, prompt: `Current fork source:\n\`\`\`js\n${cur}\n\`\`\`\n\nRequested change: ${String(prompt || '')}`, maxTokens: 4000 })) || ''); }
            catch (e) { return { ok: false, error: `edit agent failed: ${(e && e.message) || e}` }; }
            const code = extractJs(out2); if (!code) return { ok: false, error: 'the edit agent returned no code' };
            // RENDER SMOKE (chat-1cbe89a9 loop): the error is THIS tool-step's result, so the conversational
            // editor sees its own failure in the same turn and iterates — the broken version never lands.
            const smoke2 = await renderCheck(code, { kind: 'fork' });
            if (!smoke2.ok) return { ok: false, error: `the edited fork FAILED a real render check — the edit was NOT saved (the previous version stays live). It would break with: ${smoke2.error}. Rewrite the source (fix that error) and call editFork again.` };
            const r2 = forks.edit(id, code, owner, String(prompt || 'agent edit').slice(0, 60));
            if (r2 && r2.ok) edited = { version: r2.version };
            return r2;
          } },
          // the owner facet's resolution verb, in-conversation: fixed (or acknowledged) an item → clear it
          // from the open view (the backlog cell pushes the change to any live badge immediately).
          resolveBacklogItem: { run: async ({ itemId, status } = {}) => componentBacklog.setStatus(id, String(itemId || ''), status === 'ack' ? 'ack' : 'done') },
        };
        const manifest = [
          { name: 'readForkSource', description: `Read the CURRENT source of the "${name}" fork (a single (endowments, props) => vnode function expression). Read it before editing so you change the real code.`, args: {} },
          { name: 'editFork', description: `Apply a change to the "${name}" fork: an edit agent rewrites its (endowments,props)=>vnode source from your prompt, appends a new revertable version, and applies it LIVE. Make the prompt precise + self-contained.`, args: { prompt: 'string — a precise description of the change to make' } },
          { name: 'resolveBacklogItem', description: `Mark an OPEN BACKLOG item of "${name}" resolved once you have addressed it (or 'ack' to acknowledge without fixing). Item ids are listed in your context under OPEN BACKLOG.`, args: { itemId: 'string — the backlog item id (bl-…)', status: "string — 'done' (default) or 'ack'" } },
        ];
        const persona = `You are the focused editor agent for the live fork "${name}" — one confined UI component rendered inline. You can readForkSource() to see its current source and editFork({prompt}) to change it (a new revertable version, applied live). Converse with the owner: if the request is clear, make the change with editFork then answer() what you did; if it is genuinely ambiguous, ask() ONE specific clarifying question first. Keep the fork working. Be concise.${blNote}`;
        // contextPreview (owner-gated): return what the editor agent WOULD see — the observability seam
        // the staging test uses to prove the backlog injection without an LLM turn (like /chat/context).
        if (body.contextPreview) return json(res, 200, { ok: true, preview: true, persona, backlogOpen: componentBacklog.counts(id).open });
        let r; try { r = await AGENT_RUNNER({ toolbox, manifest, userText: message, history, persona, model: 'anthropic:claude-opus-4-8' }); }
        catch (e) { return json(res, 200, { ok: false, error: (e && e.message) || String(e) }); }
        return json(res, 200, { ok: true, answer: r.answer || '', asking: !!r.asking, blocked: !!r.blocked, edited, steps: (r.toolsUsed || []).map(x => x.name) });
      }
      return json(res, 404, { ok: false, error: 'unknown forks route' });
    }

    // ⚑ ADD-ONLY backlog filing by a COMPONENT-SHARE RECIPIENT (token, NO cap — so it lives OUTSIDE the
    // root-gated /components/ block below). Mirrors /forks/backlog/report: a valid share token designates
    // WHICH component to file against and grants exactly that one verb — no list/ack/subscribe.
    if (req.method === 'POST' && u.pathname === '/components/backlog/report') {
      const { shareToken, title, body: text, kind } = await jsonBody(req);
      const share = componentShares.get(String(shareToken || ''));
      if (!share) return json(res, 403, { ok: false, error: 'this share link is no longer valid' });
      const r = componentBacklog.add(share.componentId, { kind: kind === 'request' ? 'request' : 'issue', title, body: text, from: backlogOriginOf(shareToken) });
      return json(res, 200, r.ok ? { ok: true, deduped: !!r.deduped } : r); // add-only: no backlog state echoes back
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
        maybeAutoRevise(); // autonomously kick the worst un-revised high/critical pending tool (bounded: one at a time)
        return json(res, 200, { tools: customTools.listAll() });
      }
      if (u.pathname === '/tools/revise') {
        // MANUAL trigger of the review→revise loop on one pending component (the ✨ Revise button).
        const t = customTools.listAll().find(x => x.id === String(body.id || '') && x.status === 'pending');
        if (!t) return json(res, 200, { ok: false, error: 'no such pending component' });
        if (!t.review) { try { const rv = await runReviewPanel(t, { callLLM, ranAt: new Date().toISOString() }); customTools.setReview(t.id, rv); t.review = rv; } catch { /* advisory */ } }
        return json(res, 200, await reviseTool(t));
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
        if (r.ok && t) { try { await componentGit.commit(t.id, sourceFilesOf(t), `admit: ${t.name}`); } catch (e) { log('component-git admit', e.message); } componentBacklog.ensure(t.id); } // admission = the component's birth as a project-object → its backlog exists from here
        return json(res, 200, r);
      }
      if (u.pathname === '/tools/reject') return json(res, 200, customTools.reject(String(body.id || '')));
      if (u.pathname === '/tools/pending-count') return json(res, 200, { count: customTools.listAll().filter(t => t.status === 'pending').length }); // cheap (no panel) — for the tab badge
      // the agent↔Agent C "internal messages" chat (tool pipeline: proposed → reviewed → organized → admitted)
      if (u.pathname === '/internal-messages/load') return json(res, 200, listInternal({ limit: 250 }));
      // COMPONENT = git-as-Endo object: version history / read-at-version / non-destructive revert.
      // ISLAND components (confined-Preact UI, id "island-…") route to islandSource (rewrite client file + rebuild).
      if (u.pathname === '/components/islands') return json(res, 200, { ok: true, islands: islandSource.list() });
      if (u.pathname === '/components/list-ui') { // every broken-out UI component (source + declared cells) — for the gallery
        const out = [];
        for (const id of componentGit.list().filter(x => x.startsWith('uicomp-'))) {
          try { const snap = await componentGit.readAt(id, 'HEAD'); if (!snap || !snap.files['component.js']) continue; let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ } out.push({ id, name: meta.name || id, cells: Array.isArray(meta.cells) ? meta.cells : [], source: snap.files['component.js'] }); } catch { /* skip unreadable */ }
        }
        return json(res, 200, { ok: true, components: out });
      }
      // Throw a broken-out (uicomp-) component out of the gallery — permanent. Closes the gap that let
      // dev/test artifacts accumulate with no way to remove them.
      if (u.pathname === '/components/delete-ui') { const id = String(body.id || ''); if (!/^uicomp-/.test(id)) return json(res, 200, { ok: false, error: 'only broken-out uicomp- components can be deleted here' }); return json(res, 200, { ok: componentGit.remove(id), id }); }
      // BREAK OUT a chat-message component into a standalone, VERSIONED git-object module (Tier 2). The
      // source + its declared cells are committed to component-git, so it gets history/fork/revert like any
      // component and a standalone home at /c/<id>. (Cross-user share with a scoped cap is the next step.)
      if (u.pathname === '/components/break-out') {
        const src = String(body.source || ''); if (!/^\s*\(?\s*[a-zA-Z_$]/.test(src) || !src.includes('=>') || src.length > 8000) { const e = 'invalid component source (must be a function (ui) => …)'; flagErrorForFix('component-source-parse', e, `A broken-out component's source failed (ui)=>element validation. It began: ${src.slice(0, 200).replace(/\s+/g, ' ')}`).catch(() => {}); return json(res, 200, { ok: false, error: e }); }
        // RENDER SMOKE: don't immortalize a component that can't mount — the library must hold working modules.
        const boSmoke = await renderCheck(src, { kind: 'ui' });
        if (!boSmoke.ok) return json(res, 200, { ok: false, error: `this component fails a render check (${boSmoke.error}) — fix it before breaking it out` });
        const cells = (Array.isArray(body.cells) ? body.cells : []).map(String).slice(0, 8);
        const name = String(body.name || 'component').slice(0, 60);
        const id = `uicomp-${crypto.randomBytes(5).toString('hex')}`;
        const files = { 'component.js': src, 'manifest.json': JSON.stringify({ name, cells, kind: 'ui-component', createdAt: new Date().toISOString() }, null, 2) };
        try { await componentGit.commit(id, files, `break out: ${name}`); } catch (e) { return json(res, 200, { ok: false, error: `could not save: ${(e && e.message) || e}` }); }
        componentBacklog.ensure(id); // breaking it out IMPLICITLY endows the creator with its backlog (owner facet, empty from birth)
        return json(res, 200, { ok: true, id, name, url: `/c/${id}` });
      }
      if (u.pathname === '/components/ui') { // read a broken-out component back (for the standalone render)
        const id = String(body.id || ''); const snap = await componentGit.readAt(id, String(body.version || 'HEAD'));
        if (!snap || !snap.files['component.js']) return json(res, 200, { ok: false, error: 'unknown component' });
        let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ }
        return json(res, 200, { ok: true, id, source: snap.files['component.js'], cells: meta.cells || [], name: meta.name || id });
      }
      // SHARE a broken-out component with someone else: mint a LEAST-AUTHORITY token (subscribe-only to its
      // declared cells, read-only) — NOT a chat-capable cap. Reach-VERIFY each ha:* cell against the owner's
      // cap at mint, so you can't share access to an entity you can't reach. Returns the recipient link.
      if (u.pathname === '/components/share') {
        const id = String(body.id || ''); const snap = await componentGit.readAt(id, 'HEAD');
        if (!snap || !snap.files['component.js']) return json(res, 200, { ok: false, error: 'unknown component' });
        let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ }
        const node = nodeFor(body.cap); const resolved = []; const unreachable = [];
        for (const id2 of (meta.cells || [])) {
          const m = /^ha:(.+)$/.exec(String(id2)); if (!m) { resolved.push({ id: String(id2), handle: '' }); continue; }
          const reach = node && node.haReach ? node.haReach(m[1]) : null;
          if (reach && reach.state) resolved.push({ id: String(id2), handle: m[1] }); else unreachable.push(String(id2));
        }
        if (unreachable.length) return json(res, 200, { ok: false, error: `you can't share cells you can't reach: ${unreachable.join(', ')} — open them (haFind) first` });
        const token = componentShares.create({ componentId: id, cells: resolved, readOnly: true, charge: body.charge || {} }); // charge: {scheme:free|expires|allowance, hours?, total?, perOpen?}
        return json(res, 200, { ok: true, id, name: meta.name || id, url: `/c/${id}#k=${token}`, cells: resolved.map(c => c.id), scheme: (body.charge && body.charge.scheme) || 'free' }); // url carries the token in the fragment (copy, don't render)
      }
      if (u.pathname === '/components/share/revoke') return json(res, 200, { ok: componentShares.revoke(String(body.token || '')) });
      if (u.pathname === '/components/shares') return json(res, 200, { ok: true, shares: componentShares.listFor(String(body.id || '')) }); // redacted (no tokens)
      if (u.pathname === '/components/history') { const id = String(body.id || ''); return islandSource.isIsland(id) ? json(res, 200, { ok: true, versions: await islandSource.history(id) }) : json(res, 200, { ok: true, versions: await componentGit.history(id), grains: customTools.grainData(id) }); }
      // ── the component's BACKLOG, owner facet (root cap — same gate as every /components/ verb; the
      //    implicit endowment of having created/admitted it). Live view = the backlog:<id> cell.
      if (u.pathname === '/components/backlog') { const id = String(body.id || ''); return json(res, 200, { ok: true, items: componentBacklog.list(id, { status: body.status ? String(body.status) : undefined }), counts: componentBacklog.counts(id) }); }
      if (u.pathname === '/components/backlog/ack') return json(res, 200, componentBacklog.setStatus(String(body.id || ''), body.itemId, String(body.status || 'done')));
      if (u.pathname === '/components/backlog/add') return json(res, 200, componentBacklog.add(String(body.id || ''), { kind: body.kind, title: body.title, body: body.body, from: 'owner' }));
      if (u.pathname === '/components/read') { const id = String(body.id || ''); const s = await (islandSource.isIsland(id) ? islandSource.readAt(id, String(body.version || 'HEAD')) : componentGit.readAt(id, String(body.version || 'HEAD'))); return json(res, 200, s ? { ok: true, ...s } : { ok: false, error: 'unknown component/version' }); }
      if (u.pathname === '/components/fork') { const id = String(body.id || ''); if (islandSource.isIsland(id)) return json(res, 200, { ok: false, error: 'forking an island component isn\'t supported yet — edit or revert it' }); return json(res, 200, await forkComponentTo(customTools, id, String(body.name || ''), String(body.version || 'HEAD'), 'owner')); }
      if (u.pathname === '/components/edit') { const id = String(body.id || ''); return json(res, 200, islandSource.isIsland(id) ? await editIslandSource(id, String(body.prompt || '')) : await editComponentSource(customTools, id, String(body.prompt || ''))); }
      // P2 of the live-editable plan: a REAL CodeMode agent loop scoped (by toolbox construction) to ONE
      // component — readComponentSource() + editComponent({prompt}) are its ENTIRE authority (lexical
      // confinement, the one agent loop). It converses: reads the source, asks ONE clarifying question if
      // needed (ask()), else edits + reports (answer()). The client maintains the thread + re-renders live.
      if (u.pathname === '/components/edit-chat') {
        const id = String(body.id || ''); const message = String(body.message || '').trim();
        if (!message && !body.contextPreview) return json(res, 200, { ok: false, error: 'empty message' });
        const isIsland = islandSource.isIsland(id); const t = isIsland ? null : customTools.get(id);
        // a BROKEN-OUT (uicomp-) component is a project object too — its source of truth is componentGit
        // (which readComponentSource below already reads); recognize it so its edit chat (and backlog
        // injection) works, instead of 'no such component'.
        const isBrokenOut = !isIsland && !t && /^uicomp-/.test(id) && componentGit.exists(id);
        if (!isIsland && !t && !isBrokenOut) return json(res, 200, { ok: false, error: 'no such component' });
        let name = (t && t.name) || id;
        if (isBrokenOut) { try { const snap = await componentGit.readAt(id, 'HEAD'); name = (JSON.parse((snap && snap.files['manifest.json']) || '{}').name) || id; } catch { /* keep the id */ } }
        // the component's OPEN BACKLOG rides into the editor agent's context (same source of truth as
        // the backlog:<id> cell) — the edit chat opens already informed by its filed issues/errors.
        const blNote = componentBacklog.contextNote(id, name);
        const history = (Array.isArray(body.history) ? body.history : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) })).slice(-16);
        let edited = null;
        const toolbox = {
          readComponentSource: { run: async () => { try { const snap = await (isIsland ? islandSource.readAt(id, 'HEAD') : componentGit.readAt(id, 'HEAD')); const files = (snap && snap.files) || (t ? sourceFilesOf(t) : {}); return { ok: true, name, files }; } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; } } },
          editComponent: { run: async ({ prompt } = {}) => { const r = isIsland ? await editIslandSource(id, String(prompt || '')) : await editComponentSource(customTools, id, String(prompt || '')); if (r && r.ok) edited = { version: r.version, review: r.review || null }; return r; } },
          resolveBacklogItem: { run: async ({ itemId, status } = {}) => componentBacklog.setStatus(id, String(itemId || ''), status === 'ack' ? 'ack' : 'done') },
        };
        const manifest = [
          { name: 'readComponentSource', description: `Read the CURRENT source of the "${name}" component (a {relpath:content} file map). Read it before editing so you change the real code.`, args: {} },
          { name: 'editComponent', description: `Apply a change to the "${name}" component: an edit agent rewrites its source from your prompt, commits a new revertable version, and applies it LIVE. Make the prompt precise + self-contained.`, args: { prompt: 'string — a precise description of the change to make' } },
          { name: 'resolveBacklogItem', description: `Mark an OPEN BACKLOG item of "${name}" resolved once you have addressed it (or 'ack' to acknowledge without fixing). Item ids are listed in your context under OPEN BACKLOG.`, args: { itemId: 'string — the backlog item id (bl-…)', status: "string — 'done' (default) or 'ack'" } },
        ];
        const persona = `You are the focused editor agent for the live UI component "${name}". You can readComponentSource() to see its current source and editComponent({prompt}) to change it (a new revertable version, applied live). Converse with the owner: if the request is clear, make the change with editComponent then answer() what you did; if it is genuinely ambiguous, ask() ONE specific clarifying question first. Keep the component working. Be concise.${blNote}`;
        // contextPreview (root-gated like the whole block): the observability seam — what the editor
        // agent WOULD see this turn, without an LLM run (the staging test's /chat/context equivalent).
        if (body.contextPreview) return json(res, 200, { ok: true, preview: true, persona, backlogOpen: componentBacklog.counts(id).open });
        let r; try { r = await AGENT_RUNNER({ toolbox, manifest, userText: message, history, persona, model: 'anthropic:claude-opus-4-8' }); }
        catch (e) { return json(res, 200, { ok: false, error: (e && e.message) || String(e) }); }
        return json(res, 200, { ok: true, answer: r.answer || '', asking: !!r.asking, blocked: !!r.blocked, edited, steps: (r.toolsUsed || []).map(x => x.name) });
      }
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
      const { cap, swiss, powers, label, notesFolder } = await jsonBody(req);
      if (!nodeFor(cap)?.isRoot) return json(res, 403, { error: 'changing a chat\'s powers needs your root capability' });
      const want = Array.isArray(powers) ? powers : [];
      const rc = rescopeCap(String(swiss || ''), want, notesFolder); // notesFolder: undefined keeps scope, '' clears, a path scopes notes to that subtree
      if (rc.ok) return json(res, 200, { scopedCap: rc.swiss, powers: rc.powers, notesFolder: rc.notesFolder, recovered: false });
      const out = mintScopedCap({ powers: want, label: label || 'chat', notesFolder: notesFolder || '' }); // orphaned/unknown → recover with a fresh live cap
      return json(res, 200, { scopedCap: out.swiss, powers: out.powers, notesFolder: out.notesFolder, recovered: true });
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
    // ── /apps/share: the OWNER mints a scoped, attenuated, allowance-funded grant of an app to a
    //    non-owner. Mints a confined cap (no powers — access is gated by the app-share record, least
    //    authority), records what it may reach (roots), funds an allowance purse, and returns the cap so
    //    the owner can hand off /apps/<app>#cap=<scopedcap> (copy/QR — not rendered/persisted). ──
    if (req.method === 'POST' && u.pathname === '/apps/share') {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'sharing an app needs your root capability' });
      const app = String(body.app || '').trim();
      if (app !== 'file-browser') return json(res, 400, { error: 'unknown app (only file-browser is shareable so far)' });
      const roots = (Array.isArray(body.roots) ? body.roots : []).map(String).filter(k => FILE_ROOTS.some(r => r.key === k));
      if (!roots.length) return json(res, 400, { error: 'grant at least one folder (roots)' });
      const allowanceUusd = Math.max(0, Math.round(Number(body.allowanceUusd) || defaultAllowance));
      const out = mintScopedCap({ powers: [], label: String(body.label || `${app} share`) });
      const k = appKey(out.swiss);
      appShares[k] = { app, roots, label: out.name, allowanceUusd, createdAt: new Date().toISOString() };
      saveAppShares();
      try { const p = makePurse(allowanceUusd, { onChange: (b, g) => purseStore.set(`app:${k}`, b, g) }); purseStore.set(`app:${k}`, p.balance(), p.granted()); } catch { /* purse best-effort */ }
      return json(res, 200, { scopedCap: out.swiss, app, roots, allowanceUusd, url: `${BASE_URL}/apps/${app}#cap=${out.swiss}` });
    }
    // ── File-browser island data layer: browse + read/add files WITHIN the named
    //    power folders. The OWNER (root cap) reaches all FILE_ROOTS; a non-owner holding a
    //    file-browser APP-SHARE (scoped cap) reaches ONLY its attenuated root subset. Every
    //    path is traversal-guarded by fileSafe. The confined island holds no cap + no fs. ──
    if (req.method === 'POST' && u.pathname.startsWith('/files')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      const roots = allowedFileRoots(node, body.cap); // [] = neither root nor a valid file-browser share
      if (!roots.length) return json(res, 403, { error: 'file access needs your capability (the owner, or a file-browser app-share)' });
      try {
        if (u.pathname === '/files/roots') return json(res, 200, { roots: roots.map(r => ({ key: r.key, label: r.label })) });
        const root = roots.find(r => r.key === String(body.root || '')); // restricted to the caller's allowed roots
        if (!root) return json(res, 400, { error: 'unknown or unauthorized root' });
        if (u.pathname === '/files/list') {
          const dir = fileSafe(root, body.path);
          let entries = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
              const isDir = e.isDirectory(); let size = 0, mtime = 0;
              try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
              return { name: e.name, isDir, size, mtime };
            }).sort((a, b) => (a.isDir === b.isDir) ? (a.isDir ? a.name.localeCompare(b.name) : b.mtime - a.mtime) : (a.isDir ? -1 : 1));
          } catch (e) { return json(res, 404, { error: 'folder not found' }); }
          return json(res, 200, { path: String(body.path || ''), entries });
        }
        if (u.pathname === '/files/get') {
          const pth = fileSafe(root, body.path);
          let st; try { st = fs.statSync(pth); } catch (e) { return json(res, 404, { error: 'not found' }); }
          if (st.isDirectory()) return json(res, 400, { error: 'is a directory' });
          if (st.size > 25 * 1024 * 1024) return json(res, 413, { error: 'file too large (25MB max)' });
          const buf = fs.readFileSync(pth);
          // text preview when it decodes cleanly (no NULs); always return b64 for download
          const isText = buf.length < 512 * 1024 && !buf.subarray(0, 8192).includes(0);
          return json(res, 200, { name: path.basename(pth), size: st.size, b64: buf.toString('base64'), text: isText ? buf.toString('utf8') : null });
        }
        if (u.pathname === '/files/put') {
          const b64 = String(body.b64 || '');
          if (b64.length > 34 * 1024 * 1024) return json(res, 413, { error: 'file too large (25MB max)' });
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 25 * 1024 * 1024) return json(res, 413, { error: 'file too large (25MB max)' });
          const pth = fileSafe(root, body.path);
          fs.mkdirSync(path.dirname(pth), { recursive: true });
          fs.writeFileSync(pth, buf);
          return json(res, 200, { ok: true, name: path.basename(pth), bytes: buf.length });
        }
        if (u.pathname === '/files/mkdir') { fs.mkdirSync(fileSafe(root, body.path), { recursive: true }); return json(res, 200, { ok: true }); }
        if (u.pathname === '/files/rm') {
          const pth = fileSafe(root, body.path);
          const st = fs.statSync(pth);
          if (st.isDirectory()) { fs.rmdirSync(pth); } else { fs.unlinkSync(pth); } // rmdir only removes EMPTY dirs — deliberate
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'unknown /files route' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // ── Settings → Specialists: view/edit/create the ROLE catalog the entry agent
    //    can employ(). Built-ins are read-only specs; saving one writes an operator
    //    OVERLAY (custom-roles.json) merged over the built-ins, so a new role — or an
    //    edited built-in — is immediately employable. Root-gated (dan's automation). ──
    // ── AGENT EDITOR: read/write one agent's full config (built-in or user specialist) — its system prompt
    //    (instructions) + its STANDING REFERENCE DOCUMENTS (the fold-docs pattern, surfaced friendly). The
    //    docs fold into the agent's persona at run time (see foldedPersonaFor). Root-gated. ──
    // Inspect a spawned specialist (for the inline specialist island): its ring, instructions, standing nudges,
    // and recent nudge runs — so it's expandable right in the chat where it was spawned.
    if (req.method === 'POST' && u.pathname === '/specialist/inspect') {
      const { cap, id } = await jsonBody(req);
      const node = nodeFor(cap);
      if (!node || !(node.isRoot || (node.powers && node.powers.has('specialists')))) return json(res, 403, { error: 'specialists capability required' });
      const spec = specialistFor(String(id || ''));
      if (!spec) return json(res, 404, { error: 'no such specialist' });
      let nudges = []; try { nudges = specialistNudges.list({ specialistId: spec.id }).map(n => ({ id: n.id, request: n.request, recurring: n.schedule.kind === 'interval', nextAt: n.nextAt ? new Date(n.nextAt).toISOString() : null, runs: n.runs, status: n.status })); } catch { /* */ }
      let runs = []; try { runs = (await readSeedChats()).filter(s => s && s.source === 'specialist-nudge' && s.scheduled && s.scheduled.specialist === spec.name).slice(0, 8).map(s => ({ id: s.id, title: s.title, at: s.ts, request: String(s.transcript || '').slice(0, 200) })); } catch { /* */ }
      return json(res, 200, { ok: true, id: spec.id, name: spec.name, powers: spec.powers || [], instructions: String(spec.persona || '').slice(0, 4000), nudges, runs });
    }
    if (req.method === 'POST' && u.pathname.startsWith('/agents/')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'editing agents needs your root capability' });
      try {
        if (u.pathname === '/agents/config') {
          const cfg = agentConfig(String(body.agent || ''));
          return cfg ? json(res, 200, { ok: true, config: cfg, powers: ALL_POWERS }) : json(res, 404, { error: 'no such agent' });
        }
        if (u.pathname === '/agents/save') {
          const patch = {};
          if (typeof body.instructions === 'string') patch.instructions = body.instructions;
          if (Array.isArray(body.foldDocs)) patch.foldDocs = body.foldDocs;
          if (typeof body.foldScope === 'string') patch.foldScope = body.foldScope;
          const r = saveAgentConfig(String(body.agent || ''), patch);
          return json(res, r.ok ? 200 : 400, r);
        }
        return json(res, 404, { error: 'unknown /agents route' });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname.startsWith('/roles')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node || !node.isRoot) return json(res, 403, { error: 'roles need your root capability' });
      try {
        if (u.pathname === '/roles/list') {
          const custom = new Set(customRoleNames());
          // full specs (incl prompt/output) so the editor can show + edit them
          const roles = roleList().map(r => { const full = getRole(r.role) || {}; return { ...r, prompt: full.prompt || '', output: full.output || '', foldDocs: Array.isArray(full.foldDocs) ? full.foldDocs : [], foldScope: full.foldScope || '', custom: custom.has(r.role) }; });
          return json(res, 200, { roles, powers: ALL_POWERS });
        }
        if (u.pathname === '/roles/save') {
          const name = String(body.name || '').trim();
          if (!ROLE_NAME_RE.test(name)) return json(res, 400, { error: 'role name must be [a-z][a-zA-Z0-9-]{0,40} (e.g. "triager")' });
          const store = readCustomRoles();
          store[name] = sanitizeRole(body.spec);
          writeCustomRoles(store); setCustomRoles(store);
          return json(res, 200, { ok: true, role: { role: name, ...store[name] } });
        }
        if (u.pathname === '/roles/delete') {
          const name = String(body.name || '').trim();
          const store = readCustomRoles();
          if (!(name in store)) return json(res, 404, { error: `no custom role "${name}" (built-ins can't be deleted, only overridden)` });
          delete store[name];
          writeCustomRoles(store); setCustomRoles(store);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'unknown /roles route' });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (req.method === 'POST' && u.pathname.startsWith('/projects')) {
      const body = await jsonBody(req);
      const node = nodeFor(body.cap);
      if (!node) return json(res, 403, { error: 'projects need a valid capability' });
      // MULTI-USER: every project belongs to an OWNER keyed off the cap (root → 'root'; an invited user → a
      // stable hash of their cap). A caller only ever sees/touches projects they own. `ownsTarget()` gates every
      // project-specific route; a non-owner gets 404 (indistinguishable from "no such project" — no enumeration).
      const ownerKey = node.isRoot ? 'root' : 'u:' + crypto.createHash('sha256').update(String(body.cap || '')).digest('hex').slice(0, 24);
      const ownsTarget = () => { const p = projects.getProject(body.id); return (p && (p.owner || 'root') === ownerKey) ? p : null; };
      // the powers an invited owner may put in a scheduled agent's ring (⊆ their own — never an escalation).
      const capTools = ts => node.isRoot ? (Array.isArray(ts) ? ts : []) : (Array.isArray(ts) ? ts : []).filter(t => node.powers.has(t));
      try {
        if (u.pathname === '/projects/list') return json(res, 200, { projects: projects.listProjects(ownerKey), powers: [...node.powers] });
        // scheduled agents created FROM a given chat (originChat) + their recent run-log — powers the
        // in-chat run indicator (a coalesced "ran N× since your last message · last <time>" badge).
        if (u.pathname === '/projects/agents/by-chat') {
          const cid = String(body.chatId || '');
          const agents = [];
          if (cid) for (const p of projects.listProjects(ownerKey)) for (const a of (p.scheduledAgents || [])) if (a.originChat === cid) agents.push({ id: a.id, name: a.name, project: p.name, schedule: a.schedule, nextAt: a.nextAt, lastRun: a.lastRun, runs: (a.runs || []).slice(0, 30) });
          return json(res, 200, { agents });
        }
        if (u.pathname === '/projects/create') return json(res, 200, { project: projects.createProject(body.name, ownerKey) });
        if (u.pathname === '/projects/rename') { if (!ownsTarget()) return json(res, 404, { error: 'no such project' }); return json(res, 200, { project: projects.renameProject(body.id, body.name) }); }
        if (u.pathname === '/projects/attach') { if (!ownsTarget()) return json(res, 404, { error: 'no such project' }); return json(res, 200, { project: projects.attachChat(body.id, body.chatId) }); }
        if (u.pathname === '/projects/detach') { if (!ownsTarget()) return json(res, 404, { error: 'no such project' }); return json(res, 200, { project: projects.detachChat(body.id, body.chatId) }); }
        if (u.pathname === '/projects/agents/add') {
          if (!ownsTarget()) return json(res, 404, { error: 'no such project' });
          const agent = projects.addScheduledAgent(body.id, { name: body.name, prompt: body.prompt, tools: capTools(body.tools), schedule: body.schedule, trigger: body.trigger, model: body.model }); // tools ⊆ the owner's ring — never an escalation
          if (agent.schedule) projects.updateScheduledAgent(body.id, agent.id, { nextAt: projects.computeNextAt(agent.schedule, Date.now()) }); // event-only agents have no nextAt
          return json(res, 200, { agent: projects.listScheduledAgents(body.id).find(a => a.id === agent.id) });
        }
        if (u.pathname === '/projects/agents/update') {
          if (!ownsTarget()) return json(res, 404, { error: 'no such project' });
          const patch = body.patch || {};
          if (patch.tools) patch.tools = capTools(patch.tools); // re-cap on edit too
          // when the timing changes, recompute the next fire so the edit takes effect immediately
          if (patch.schedule && patch.schedule.kind) patch.nextAt = projects.computeNextAt(patch.schedule, Date.now());
          return json(res, 200, { agent: projects.updateScheduledAgent(body.id, body.agentId, patch) });
        }
        if (u.pathname === '/projects/agents/remove') { if (!ownsTarget()) return json(res, 404, { error: 'no such project' }); projects.removeScheduledAgent(body.id, body.agentId); return json(res, 200, { ok: true }); }
        if (u.pathname === '/projects/agents/run') {
          const project = ownsTarget(); const agent = project && projects.listScheduledAgents(body.id).find(a => a.id === body.agentId);
          if (!project || !agent) return json(res, 404, { error: 'no such project/agent' });
          const out = await runProjectAgent(project, agent);
          return json(res, 200, { ok: out.ok !== false, answer: out.answer || out.error || '', toolsUsed: out.toolsUsed || [], proposals: (out.proposalIds || []).length });
        }
        // ── PROJECT HOME FOLDER: list/download/upload files in the project's shared home dir.
        //    Binary-safe (base64) so any file type round-trips; path-guarded inside the root;
        //    uploads size-bounded. Same root-cap gate as the rest of /projects. ──
        if (u.pathname.startsWith('/projects/files')) {
          const project = ownsTarget();
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
        if (!a.enabled || !a.schedule) continue; // event-only agents (no schedule) aren't clock-fired — the watcher fires them
        const due = a.nextAt ? new Date(a.nextAt).getTime() : NaN;
        if (Number.isNaN(due)) { projects.updateScheduledAgent(p.id, a.id, { nextAt: projects.computeNextAt(a.schedule, t0) }); continue; }
        if (due <= t0) { try { await runProjectAgent(p, a); } catch (e) { log('schedTick run', e.message); } }
      }
    } catch (e) { log('schedTick', e.message); } finally { ticking = false; }
  };
  setInterval(() => { schedTick().catch(e => log('schedTick', e && e.message)); }, 30000);

  // ── W4 PROPAGATOR-FIRST: a scheduled agent can be EVENT-triggered (trigger:{kind:'event',source}) — it
  //    fires the moment a doc lands in the watched vault folder, not on a clock. (dan: "wrap things into
  //    responsive propagators … kick the review the moment the document was added to the clippings folder.")
  let evFiring = false; const evDebounce = new Map(); // source → timer
  const fireEventAgents = async source => {
    if (evFiring) return; const list = projects.eventAgents(source); if (!list.length) return;
    evFiring = true;
    try { for (const { project, agent } of list) { try { log('event-agent:', `${source} → ${project.name} › ${agent.name}`); await runProjectAgent(project, agent); } catch (e) { log('event-agent run', e.message); } } }
    finally { evFiring = false; }
  };
  const watchFolder = (source, dir) => {
    try {
      fs.watch(dir, (_evt, fname) => {
        if (!fname || !String(fname).endsWith('.md')) return; // a note landed
        clearTimeout(evDebounce.get(source)); evDebounce.set(source, setTimeout(() => fireEventAgents(source).catch(e => log('fireEventAgents', e && e.message)), 4000)); // debounce a burst of writes
      });
      log('watching', `${source} (${dir}) for event-triggered agents`);
    } catch (e) { log('watch', `${source}: ${e.message}`); }
  };
  watchFolder('clippings', path.join(VAULT_DIR, 'Clippings'));
  watchFolder('inbox', path.join(VAULT_DIR, 'inbox'));
  log('scheduled-agent tick armed (30s)');
  // DURABILITY backstop: if a component-git remote is configured, sweep-push everything at boot + every 15 min
  // (the per-edit debounced push handles the hot path; this catches forks/reverts/break-outs + any missed push).
  if (componentSync.enabled) {
    log(`component-git sync ON → ${componentSync.remote}`);
    componentSync.syncAll().then(r => log(`component-git sync: pushed ${r.pushed}${r.failed ? `, ${r.failed} failed` : ''}`)).catch(e => log('component-sync boot', e.message));
    setInterval(() => { componentSync.syncAll().catch(e => log('component-sync sweep', e.message)); }, 15 * 60 * 1000);
  }

  { const c = configSummary(); log(`field mode: ${c.mode} | personal-root: ${c.personalRoot} | config: ${c.configDir} | vault: ${c.vault}`); }
  for (const ip of BIND) { const s = http.createServer(handler); s.on('error', e => log('bind', ip, e.message)); s.listen(PORT, ip, () => log(`field agent on http://${ip}:${PORT}`)); }
  // cap-hygiene: don't print the all-powers root #cap link to the log on a normal boot. Show only a
  // fingerprint; the operator gets the full link by setting PRINT_ROOT_CAP=1 (first-run bootstrap only).
  if (process.env.PRINT_ROOT_CAP === '1') log(`ROOT CAP LINK (full bundle): ${BASE_URL}/#cap=${rootSwiss}`);
  else log(`ROOT CAP ready (fp ${rootSwiss.slice(0, 6)}…; set PRINT_ROOT_CAP=1 to print the full link)`);
  log(`STT ${WHISPER}; LLM gemma tinix:8003; delegate ${process.env.DELEGATE_MODEL || 'claude-opus-4-8'}`);
};

// flush durable balances on a clean shutdown (systemd restart sends SIGTERM) so the last debits persist.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const ac of runs.values()) { try { ac.abort(); } catch { /* */ } } try { purseStore.flushNow(); } catch { /* best-effort */ } process.exit(0); });

main().catch(e => { log('FATAL', e && e.stack || e); process.exit(1); });
