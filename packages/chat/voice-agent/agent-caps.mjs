// agent-caps.mjs — the Endo permission model for the field agent.
//
// The field agent is a ROOT AGENT. Its entire authority is a bundle of object
// capabilities (Far Remotables), each attenuated to one non-destructive verb.
// The bundle is reachable ONLY through a swissnum (the unguessable token in the
// #cap= URL fragment): holding the string IS the permission. There are no
// accounts. `share(power, name)` mints a NEW swissnum bound to a sub-bundle
// (a single power, or a sub-agent) — independently revocable — so you can hand
// out "just image generation" without granting anything else.
//
// Confinement is by lexical construction: the LLM is probabilistic, but the
// `toolbox` handed to it for a turn contains ONLY the powers in its bundle.
// There is no name it can emit to reach a power it wasn't given — including the
// Opus sub-agent reached via delegateTask, whose tools are themselves an
// attenuated sub-bundle.
//
// Affordances (each wraps an already-proven implementation):
//   notes     → read dan's personal Obsidian vault (search/read/stats)  [READ-ONLY]
//   reference → consult the little-free-library (Gutenberg) + Wikipedia [READ-ONLY]
//   web       → SSRF-guarded fetch + summarize one web page             [READ-ONLY]
//   images    → generate an image on the tinix GPU (+ abort)
//   feed      → post an item to dan's daily dashboard feed
//   phone     → push a notification to dan's phone (ntfy)
//   delegate  → break a task off to a larger (Opus) agent with a sub-bundle
// Every node can additionally share/listShares/revoke the powers IT holds
// (sub-delegation) and createInvite (the voice-facing name for share).
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { Far } from '@endo/marshal';

import { generate } from '/home/dan/gpu-img/gen.mjs';
import { makeObsidianGraph } from '../capture/obsidian-graph.mjs';
import { consultReferences } from '../capture/consult.mjs';
import { notify } from '../capture/notify.mjs';
import { addTimer, cancelTimer, listTimers } from '../capture/timers.mjs';
import { createProject, listProjects, addScheduledAgent, updateScheduledAgent, removeScheduledAgent, computeNextAt, projectForChat } from './projects.mjs';
import { proposeSpawn } from '../capture/agent-spawn.mjs';
import { runOpusDelegate } from './delegate.mjs';
import { makeSelfImprover } from './self-improver.mjs';
import { listBacklog, addBacklog, nextOpen, recordOutcome } from './improvement-backlog.mjs';
import { runAgent } from '../../ocapn-noise/tool-bridge.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';
import { dialIrohObject } from './iroh-objects.mjs';
// Boot-safe: this module only static-imports node builtins; it lazy-loads @endo/daemon on first USE (when an
// agent actually redeems an Endo invitation), so importing it can never crash voice-agent boot.
import * as endoPeer from './endo-peer-bridge.mjs';
import { postInternal } from './internal-messages.mjs'; // the agent↔Agent C "internal messages" chat (tool pipeline)
// Sub-agents (scheduled, specialists, employed roles) run the composable-code harness (CEO-Bench: it
// beats per-tool calls + specialized harnesses) by default. AGENT_CODEMODE=0 reverts to the classic loop.
const AGENT_RUNNER = process.env.AGENT_CODEMODE === '0' ? runAgent : runAgentCode;
// A delegator-supplied NICKNAME → a readable, url-safe sub-agent id stem (or '' if none). A short
// unique suffix is appended at the call site, so the same nickname can name many concurrent delegates.
const nickId = s => String(s || '').trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
// A whimsical, HUMAN-READABLE pet name for a delegated/scoped agent — so the chat shows "Cobalt Otter",
// never an ugly id like "scoped-a0a6c7a3". The entry agent SHOULD propose its own (nickname arg); this
// is the friendly fallback when it doesn't. crypto-seeded for a unique-ish pick (Math.random is
// non-deterministic + discouraged under SES; the rest of the file uses crypto.randomBytes too).
const PET_ADJ = harden(['Amber', 'Brisk', 'Cobalt', 'Crimson', 'Dapper', 'Electric', 'Frosty', 'Gilded', 'Hazel', 'Indigo', 'Jolly', 'Keen', 'Lunar', 'Mellow', 'Nimble', 'Opal', 'Plucky', 'Quartz', 'Russet', 'Sable', 'Teal', 'Umber', 'Velvet', 'Wandering', 'Zesty', 'Azure', 'Bramble', 'Clever', 'Drifting', 'Ember', 'Golden', 'Silver']);
const PET_NOUN = harden(['Falcon', 'Otter', 'Comet', 'Heron', 'Lynx', 'Marmot', 'Nimbus', 'Osprey', 'Puffin', 'Quokka', 'Raven', 'Stoat', 'Tapir', 'Vireo', 'Walrus', 'Yak', 'Badger', 'Civet', 'Dingo', 'Ferret', 'Gannet', 'Ibis', 'Jackal', 'Kestrel', 'Lemur', 'Meerkat', 'Narwhal', 'Pangolin', 'Sparrow', 'Wren']);
const genPetName = () => { const b = crypto.randomBytes(2); return `${PET_ADJ[b[0] % PET_ADJ.length]} ${PET_NOUN[b[1] % PET_NOUN.length]}`; };
import { addAsk, getSecret } from './asks-store.mjs';
import { makeConnectors } from './connectors.mjs';
import { makeCustomTools } from './custom-tools.mjs';
import { makeToolShares } from './tool-shares.mjs';
import { makeComponentGit } from './component-git.mjs';
import { buildSystemMap } from './system-map.mjs';
import { braveSearch } from './brave-search.mjs';
import { runResearch } from './research.mjs';
import { getRole, roleList, localModelFor } from './agent-roles.mjs';
import { scanArea as dietScan, evaluateArea as dietEval, buildMap as dietBuild, regenSite as dietRegen, publishSite as dietPublish, status as dietStat, DIET_SITES } from './dietician-js.mjs';
import { makeHaTrie } from './homeassistant-trie.mjs';
import { makeAgentRoster } from './agents-roster.mjs';
import { makeHomeFolder } from './agent-home.mjs';
import { sendMail } from './email-smtp.mjs';
import { makeContacts } from './contacts.mjs';
import { getTranscript } from './youtube.mjs';

export const HOME_BASE = '/home/dan/.local/state/field-agent/home';
const PERSONA_FILE = '/home/dan/.config/field-agent/persona.txt'; // the agent's self-authored, operator-confirmed instructions
const EMAIL_CFG = '/home/dan/.config/field-agent/email.json'; // SMTP relay creds for the email power (never in code/chat)
const EMAIL_FROM = 'bot@danfinlay.com'; // default From for the bot's outbound mail
const KAZPUTER_URL = process.env.KAZPUTER_URL || 'http://127.0.0.1:8779'; // kazputer-phone RPC (loopback, same host)
const KAZPUTER_STATE = '/home/dan/.config/kazputer-phone/instances.json'; // holds the provisioner cap (read live)

const FEED_MJS = path.resolve('/home/dan/endo-bfb/packages/chat/dashboard/feed.mjs');
const FEED_FILE = '/home/dan/.local/state/field-dashboard/feed.json'; // the dashboard's durable feed — reused as the notification data endowment (the 🔔 bell reads it)
const VAULT = '/home/dan/obsidian/vault';
const HA_URL = (process.env.HOMEASSISTANT_URL || 'http://192.168.50.11:8123').replace(/\/$/, '');
const VM_HOST = process.env.VM_HOST || 'agent@10.89.0.3'; // the agent-code dev persona
const newSwiss = () => crypto.randomBytes(16).toString('hex');

// ── per-sub-agent git WORKTREE isolation ─────────────────────────────────────
// A write-capable role/dev sub-agent (executor/tester/debugger) runs its host shell
// in its OWN git worktree for the duration of its work, so parallel writers edit
// DISJOINT checkouts and cannot race. This is the mechanism that retires the old
// "writes are single-threaded" rule (roles.test.mjs THE WRITE RULE).
//   IMPORTANT — a worktree is RACE-ISOLATION + a recoverable diff, NOT a security
//   sandbox. `host` is ambient host-root by construction (a shell command can still
//   `cd` elsewhere or use absolute paths); the worktree only sets the DEFAULT working
//   dir + guards the cwd PARAMETER. True escape-confinement is the @endo/sandbox
//   (bwrap/podman) layer — tracked separately (see endo_sandbox_genie memory).
const WORKTREE_DIR = process.env.FIELD_AGENT_WORKTREE_DIR || '/home/dan/.local/state/field-agent/worktrees';
const WORKTREE_REPO = process.env.FIELD_AGENT_WORKTREE_REPO || '/home/dan/endo-bfb-llm'; // self-improvement default; override per-deployment
const WORKTREE_BASE_REF = process.env.FIELD_AGENT_WORKTREE_BASE || 'HEAD';
// ── KERNEL confinement for worktree sub-agents (bubblewrap). A worktree-jailed hostExec (the self-improve
//    executor + isolation:'worktree' roles) runs inside a bwrap sandbox that BINDS ONLY its worktree
//    (writable) + a read-only toolchain/repo, and DENIES the rest of the host: no ~/.ssh, no ~/.env, no
//    write outside the worktree, no network. This upgrades the worktree from race-isolation to a REAL
//    boundary, so a misaligned/adversarial executor goal can't read secrets or escape. Falls back to the
//    cwd-jail if bwrap is absent (WORKTREE_BWRAP=0 forces the fallback). ──
export const BWRAP_BIN = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
export const WORKTREE_BWRAP = !!BWRAP_BIN && process.env.WORKTREE_BWRAP !== '0';
const REPO_GIT_COMMON = process.env.FIELD_AGENT_GIT_COMMON || '/home/dan/endo-bfb'; // the shared .git common dir for the field-preact worktree
const roBindIf = p => { try { return fs.existsSync(p) ? ['--ro-bind', p, p] : []; } catch { return []; } };
// the static (per-process) bind set: a minimal read-only system + the live repo (deps/git/code, READ-only).
export const BWRAP_BASE = WORKTREE_BWRAP ? [
  ...roBindIf('/usr'), ...roBindIf('/etc'), ...roBindIf('/lib'), ...roBindIf('/lib64'),
  ...roBindIf('/bin'), ...roBindIf('/sbin'), ...roBindIf('/opt'),
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ...roBindIf(WORKTREE_REPO), ...roBindIf(REPO_GIT_COMMON),
  '--unshare-all', '--die-with-parent',
] : [];
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote a value for shell interpolation
const wtSlug = s => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'wt';

// Resolve an agent-supplied cwd against a worktree JAIL dir; refuse to escape it.
// Exported so the escape logic — the security-critical part — is unit-testable offline.
export const resolveJailedCwd = (jail, cwd) => {
  if (!cwd) return harden({ ok: true, cwd: jail });
  const resolved = path.resolve(jail, String(cwd).replace(/^\/+/, '')); // treat as relative-to-jail
  if (resolved !== jail && !resolved.startsWith(jail + path.sep)) return harden({ ok: false, error: `cwd escapes your worktree (${jail})` });
  // Symlink defense: the syntactic check above is fooled by a symlink INSIDE the worktree that points
  // out (the agent could `ln -s /etc esc` then cwd:'esc'; `cd` follows it). Resolve symlinks on the jail
  // and the deepest existing ancestor of the target, then re-check containment. (Best-effort: in a unit
  // context where the jail dir doesn't exist, realpath throws → the syntactic guard stands.)
  try {
    const realJail = fs.realpathSync(jail);
    let probe = resolved;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realJail && !realProbe.startsWith(realJail + path.sep)) return harden({ ok: false, error: 'cwd resolves (via a symlink) outside your worktree' });
  } catch { /* realpath unavailable (e.g. jail missing in a unit test) → keep the syntactic result */ }
  return harden({ ok: true, cwd: resolved });
};
harden(resolveJailedCwd);

// The worktree manager runs on the UNCONFINED host shell (it IS trusted harness, not
// the sub-agent). create() spins a fresh worktree+branch off WORKTREE_BASE_REF;
// teardown() COMMITS any dirty work to the branch FIRST (never lose a sub-agent's
// diff), then removes the dir — and on commit failure it REFUSES to remove (leaves
// the work on disk). The branch is never auto-merged or deleted: promotion is the
// operator's gated call (matches the dev-spawner / blacksmith merge-back discipline).
export const makeWorktrees = ({ host, repo = WORKTREE_REPO, dir: baseDir = WORKTREE_DIR, baseRef = WORKTREE_BASE_REF }) => {
  const dirFor = id => path.join(baseDir, wtSlug(id));
  const branchFor = id => `agentwt/${wtSlug(id)}`;
  const create = async id => {
    const dir = dirFor(id); const branch = branchFor(id);
    await host.exec(`mkdir -p ${shq(baseDir)}`, { timeoutMs: 15000 });
    const add = () => host.exec(`git -C ${shq(repo)} worktree add --quiet -b ${shq(branch)} ${shq(dir)} ${shq(baseRef)}`, { timeoutMs: 180000 });
    let r = await add();
    if (!r.ok) {
      // SAFE reclaim: `git worktree prune` ONLY garbage-collects worktree REGISTRATIONS whose dirs are
      // already gone — it never deletes a branch or removes any work. We deliberately do NOT force-delete
      // the branch or rm the dir: ids are unique per spawn, so a real collision is astronomically unlikely,
      // and force-reclaiming could destroy un-merged work on a leaked branch. On persistent failure we
      // REFUSE (throw) rather than destroy anything.
      await host.exec(`git -C ${shq(repo)} worktree prune`, { timeoutMs: 30000 });
      r = await add();
      if (!r.ok) throw new Error(`git worktree add failed (refusing to force-reclaim an existing branch/dir so no un-merged work is lost): ${String(r.stderr || r.stdout || '').slice(0, 200)}`);
    }
    return harden({ id: String(id), dir, branch, repo });
  };
  const teardown = async (id, { commitMessage = 'agent worktree' } = {}) => {
    const dir = dirFor(id); const branch = branchFor(id);
    const st = await host.exec(`git -C ${shq(dir)} status --porcelain`, { timeoutMs: 30000 });
    const dirty = !!(st.ok && String(st.stdout || '').trim());
    let committed = false;
    if (dirty) {
      // `add -A` captures all tracked + untracked NON-ignored changes (the sub-agent's actual source
      // work). Gitignored content (node_modules, build output, *.o) is regenerable and intentionally NOT
      // preserved — committing it would bloat the shared repo and is the wrong semantics. The committed
      // branch is exactly the reviewable diff.
      const c = await host.exec(`git -C ${shq(dir)} add -A && git -C ${shq(dir)} -c user.name=${shq('Agent C worktree')} -c user.email=${shq('agent-c@archua.local')} commit --quiet -m ${shq(commitMessage)}`, { timeoutMs: 60000 });
      committed = c.ok;
      // SAFE TEARDOWN: commit failed → do NOT remove; leave the work on disk + surface it. A leaked
      // worktree is recoverable; lost work is not. (next create() with this id prunes the stale dir.)
      if (!committed) return harden({ removed: false, committed: false, dirty: true, branch, dir, note: 'commit failed — worktree LEFT IN PLACE so no work is lost' });
    }
    const rm = await host.exec(`git -C ${shq(repo)} worktree remove --force ${shq(dir)} && git -C ${shq(repo)} worktree prune`, { timeoutMs: 30000 });
    return harden({ removed: rm.ok, committed, dirty, branch, dir,
      note: rm.ok ? (dirty ? `work committed to ${branch}` : 'clean — nothing to keep') : `remove failed — ${branch} + dir preserved` });
  };
  return harden({ create, teardown, dir: baseDir, repo, baseRef });
};
harden(makeWorktrees);

// Read a secret from the process env, falling back to ~/.env (the systemd unit
// doesn't source ~/.env; the long-lived HA token lives there as HOMEASSISTANT=).
let dotenvCache;
const fromEnv = key => {
  if (process.env[key]) return process.env[key];
  if (dotenvCache === undefined) { try { dotenvCache = fs.readFileSync('/home/dan/.env', 'utf8'); } catch { dotenvCache = ''; } }
  const m = dotenvCache.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
};

// Resolve a vault-relative path for WRITING; refuses to escape the vault or to
// touch .obsidian config. (The read-only `notes` cap uses obsidian-graph's own guard.)
const vaultWritePath = rel => {
  const p = path.resolve(VAULT, String(rel || '').replace(/^\/+/, ''));
  if (p !== VAULT && !p.startsWith(VAULT + path.sep)) throw new Error('path escapes the vault');
  if (p.includes(`${path.sep}.obsidian${path.sep}`)) throw new Error('refusing to write inside .obsidian');
  if (!p.endsWith('.md')) throw new Error('only .md notes may be edited');
  return p;
};
// Is vault-relative path `p` inside `prefix` (empty prefix = whole vault)? For confining a notes share.
const underPrefix = (p, prefix) => { if (!prefix) return true; const a = String(p || '').replace(/^\/+/, ''); const b = String(prefix).replace(/\/+$/, ''); return a === b || a.startsWith(`${b}/`); };
// Resolve a vault-relative path for READING a directory/file; refuses to escape the vault.
const vaultReadPath = rel => {
  const p = path.resolve(VAULT, String(rel || '').replace(/^\/+/, ''));
  if (p !== VAULT && !p.startsWith(VAULT + path.sep)) throw new Error('path escapes the vault');
  return p;
};

// ── SSRF-guarded outbound GET (copied from the capture agent's FetchLink) ─────
const isPrivateIp = ip => {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
};
const ssrfOk = async u => {
  let url; try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  try { const recs = await dns.lookup(url.hostname, { all: true }); return recs.length > 0 && recs.every(r => !isPrivateIp(r.address)); }
  catch { return false; }
};
const stripHtml = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const fetchPage = async (u, { maxBytes = 1_500_000, timeoutMs = 12000 } = {}) => {
  if (!(await ssrfOk(u))) return { ok: false, error: 'blocked/invalid url' };
  let res;
  try { res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'field-agent/1.0 (+tailnet, read-only)' } }); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  if (res.url && res.url !== u && !(await ssrfOk(res.url))) return { ok: false, error: 'redirected to blocked host' };
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/(xhtml|json)/.test(ct)) return { ok: false, error: `unsupported type ${ct.split(';')[0]}` };
  const reader = res.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length; if (total > maxBytes) { try { await reader.cancel(); } catch {} return { ok: false, error: 'too large' }; }
    chunks.push(Buffer.from(value));
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ok: true, title, text: stripHtml(html).slice(0, 8000), finalUrl: res.url || u };
};

// ── post to the daily dashboard feed (shell out to the proven feed.mjs CLI) ───
const postFeed = ({ title, body = '', status = '🗣️ from the voice agent', note = '', links = [], agent = '' }) =>
  new Promise(res => {
    const a = ['post', '--title', String(title || 'note'), '--status', status, '--note', note, '--body', String(body)];
    if (agent) a.push('--agent', String(agent));
    for (const l of links) if (l) a.push('--link', String(l));
    execFile('node', [FEED_MJS, ...a], { timeout: 30000 }, (err, so, se) => res({ ok: !err, error: err ? (se || err.message) : '' }));
  });

// ── headless browser worker (out-of-SES-realm; see browser-run.cjs). Returns parsed JSON.
const BROWSER_RUN = '/home/dan/endo-bfb/packages/chat/voice-agent/browser-run.cjs';
const runBrowser = args => new Promise(res => {
  execFile('node', [BROWSER_RUN, ...args], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) => {
    if (err) return res({ ok: false, error: String(se || err.message || '').slice(0, 300) });
    try { res(JSON.parse(String(so).trim().split('\n').pop())); } catch { res({ ok: false, error: 'bad worker output: ' + String(so).slice(0, 200) }); }
  });
});

// ── the affordance caps. Each is a hardened Remotable attenuated to one verb. ─
// outDir: where generated images land (served back to the browser as data URLs).
const makeAffordances = ({ outDir }) => {
  fs.mkdirSync(outDir, { recursive: true });
  const graph = makeObsidianGraph(); // exposes ONLY search/read/stats — no write/send
  return harden({
    notes: Far('PersonalNotes', {
      help: () => 'Read-only access to dan\'s personal Obsidian vault. search(query)/read(relpath)/stats(). No write, no send.',
      search: async (query, opts) => graph.search(query, opts),
      read: async rel => graph.read(rel),
      stats: async () => graph.stats(),
    }),
    reference: Far('Reference', {
      help: () => 'Read-only: consult dan\'s little-free-library (Project Gutenberg books) + local Wikipedia. ask(question).',
      ask: async question => consultReferences(String(question || '')),
    }),
    web: Far('Web', {
      help: () => 'Read-only: fetch + summarize ONE public web page (SSRF-guarded). get(url). search(query) = Brave web search → top results.',
      get: async url => fetchPage(String(url || '')),
      search: async query => braveSearch(String(query || '')),
    }),
    browser: Far('Browser', {
      help: () => 'A real headless browser (renders JS). visit(url) → {title,text,url}; shot(url) → a saved screenshot path. SSRF-guarded; runs out-of-process.',
      visit: async url => {
        const u = String(url || '');
        if (!(await ssrfOk(u))) return harden({ ok: false, error: 'blocked/invalid url (private/loopback or non-http)' });
        return harden(await runBrowser(['visit', u]));
      },
      shot: async url => {
        const u = String(url || '');
        if (!(await ssrfOk(u))) return harden({ ok: false, error: 'blocked/invalid url' });
        const fname = `shot-${crypto.randomBytes(8).toString('hex')}.png`;
        const outp = path.join(outDir, 'uploads', fname);
        fs.mkdirSync(path.dirname(outp), { recursive: true });
        const r = await runBrowser(['shot', u, outp]);
        // savedTo MUST be the filesystem path (the server reads/copies it for inline render + a durable
        // /uploads copy); webPath is the served URL. Returning a web path as savedTo broke both (imgcopy ENOENT).
        return harden(r.ok ? { ok: true, savedTo: outp, webPath: `/uploads/${fname}`, title: r.title, url: r.url } : r);
      },
    }),
    images: Far('Images', {
      help: () => 'Generate an image on the GPU and save it. generate(prompt). Reversible: abort() interrupts an in-flight render.',
      generate: async ({ prompt }) => {
        const p = String(prompt || '').trim().slice(0, 400);
        if (!p) throw new Error('prompt required');
        const r = await generate(p, { steps: 4, width: 512, height: 512, seed: Math.floor(Date.now() % 1e9) });
        const file = `${outDir}/image-${Date.now()}.png`;
        fs.writeFileSync(file, r._buf);
        return harden({ ok: true, savedTo: file, prompt: p, bytes: r.info.bytes, ms: r.info.ms });
      },
      abort: async () => { try { await fetch('http://192.168.50.226:8188/interrupt', { method: 'POST' }); } catch {} },
    }),
    feed: Far('Feed', {
      help: () => 'dan\'s notification feed (the 🔔 inbox). post({title,body,links}) = routine; notify({title,body,agent}) = a "needs your attention" action item; recent() reads the inbox.',
      post: async ({ title, body, links } = {}) => postFeed({ title, body, links: Array.isArray(links) ? links : [] }),
      notify: async ({ title, body, agent, link } = {}) => postFeed({ title, body, status: '🔔 needs your attention', agent: String(agent || ''), links: link ? [String(link)] : [] }),
      recent: async (n = 40) => { try { const j = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')); return (j.entries || []).slice(0, n).map(e => harden({ id: e.id, date: e.date, title: e.title, status: e.status || '', agent: e.agent || '' })); } catch { return []; } },
    }),
    phone: Far('Phone', {
      help: () => 'Push a notification to dan\'s phone (ntfy). push({title, message, click}).',
      push: async ({ title, message, click, priority, tags } = {}) =>
        notify({ title: String(title || 'Field agent'), message: String(message || ''), click: click ? String(click) : '', priority: priority || 'default', tags: tags || ['speech_balloon'] }),
    }),
    youtube: Far('YouTube', {
      help: () => 'Fetch a YouTube video\'s transcript/captions (read-only, YouTube hosts only). transcribe({url}).',
      transcribe: async ({ url } = {}) => getTranscript(String(url || '')),
    }),
    kazputer: Far('Kazputer', {
      help: () => 'Provision a new Kazputer (a kid-phone instance) via the kazputer-phone provisioner cap; returns its kid + admin invite links. provision({name, owner}).',
      provision: async ({ name, owner } = {}) => {
        let provisioner; try { provisioner = JSON.parse(fs.readFileSync(KAZPUTER_STATE, 'utf8')).provisioner; } catch { /* not built */ }
        if (!provisioner) return harden({ ok: false, error: 'kazputer-phone unavailable (no provisioner cap on disk)' });
        try {
          const r = await (await fetch(`${KAZPUTER_URL}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: provisioner, method: 'createKazputer', args: [String(name || 'Kazputer'), String(owner || '')] }) })).json();
          return harden(r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error || 'provision failed' });
        } catch (e) { return harden({ ok: false, error: e.message }); }
      },
    }),
    // Durable timers (survive restarts; fired by timer-runner.service). ATTENUATED
    // to notify-only: a scheduled wake-up fires as a phone push. The underlying
    // timers.mjs also supports {type:'command'} (arbitrary shell) — that is
    // deliberately NOT exposed, since it would let a holder (or an Opus delegate)
    // escape the cap sandbox into a host shell.
    timers: Far('Timers', {
      help: () => 'Schedule durable wake-ups/reminders (survive restarts). schedule({delayMs|atIso,title,message}), repeat({everyMs,title,message}), cancel(id), list(). Wake-ups fire as a phone push — they CANNOT run shell commands.',
      schedule: async ({ delayMs, atIso, title, message, priority } = {}) => {
        const action = { type: 'notify', title: String(title || 'Reminder'), message: String(message || ''), priority: priority || 'default' };
        const dueAt = atIso ? String(atIso) : new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();
        return addTimer({ kind: 'once', dueAt, action, label: String(title || '') });
      },
      repeat: async ({ everyMs, title, message, priority } = {}) => {
        const ms = Math.max(1000, Number(everyMs) || 0);
        const action = { type: 'notify', title: String(title || 'Reminder'), message: String(message || ''), priority: priority || 'default' };
        return addTimer({ kind: 'interval', everyMs: ms, action, label: String(title || '') });
      },
      cancel: async id => cancelTimer(String(id || '')),
      list: async () => listTimers(),
    }),
    // ── EXECUTORS for destructive actions ──────────────────────────────────
    // These hold the REAL authority to mutate the world. They are NEVER put in
    // the agent's toolbox. The agent only gets `propose*` verbs that register a
    // pending proposal whose stored commit() closure calls one of these — and
    // commit() runs only after the operator confirms (root-cap-gated). So the
    // agent can DESCRIBE a destructive act but cannot PERFORM one.
    editNote: Far('EditNoteExec', {
      help: () => 'Read/overwrite a vault .md note. OVERWRITE (write) is reached ONLY via a confirmed proposal. createNew/appendTo are NON-DESTRUCTIVE (only ever ADD) so the agent may call them directly.',
      read: async rel => { try { return fs.readFileSync(vaultWritePath(rel), 'utf8'); } catch { return ''; } },
      write: async (rel, content) => { const p = vaultWritePath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(content ?? '')); return harden({ ok: true, savedTo: p, bytes: Buffer.byteLength(String(content ?? '')) }); },
      // NON-DESTRUCTIVE create: atomic 'wx' write — fails with EEXIST rather than ever clobbering an
      // existing note. The caller uniquifies the name on EEXIST, so this can NEVER lose data.
      createNew: async (rel, content) => { const p = vaultWritePath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(content ?? ''), { flag: 'wx' }); return harden({ ok: true, savedTo: p, bytes: Buffer.byteLength(String(content ?? '')) }); },
      // NON-DESTRUCTIVE append: only ever ADDS to the end (creates the file if missing). Never removes.
      appendTo: async (rel, content) => { const p = vaultWritePath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); const sep = fs.existsSync(p) ? '\n' : ''; fs.appendFileSync(p, `${sep}${String(content ?? '')}`); return harden({ ok: true, savedTo: p, appended: true, bytes: Buffer.byteLength(String(content ?? '')) }); },
    }),
    // NOTE: HomeAssistant is NOT a flat executor here. It is a full OBJECT TRIE
    // built by makeHaTrie() (see buildHomeAssistant below). The agent designates
    // entities by holding+navigating trie nodes (web-key handles), never by a
    // string entity_id the server re-resolves against the ambient HA token — that
    // string-designation is the Confused Deputy this whole model avoids.
    // SMTP send is the COMMIT of an `email` proposal — it runs ONLY after the
    // operator confirms (the agent itself can only proposeEmail). With relay creds
    // in ~/.config/field-agent/email.json it actually sends as bot@danfinlay.com;
    // with no creds (or on send failure) it falls back to a reviewed draft, so a
    // confirmed email is never silently lost.
    email: Far('EmailExec', {
      help: () => `Sends a confirmed email via your SMTP relay (creds in ${EMAIL_CFG}), or drafts to the vault outbox if no creds. Outbound is gated: the agent only PROPOSES; you confirm.`,
      send: async ({ to, subject, body }) => {
        const dir = `${VAULT}/the field/TADA/outbox`; fs.mkdirSync(dir, { recursive: true });
        const toS = String(to || ''); const subjS = String(subject || ''); const bodyS = String(body || '');
        let cfg = null; try { cfg = JSON.parse(fs.readFileSync(EMAIL_CFG, 'utf8')); } catch { /* no creds → draft */ }
        if (cfg && cfg.host && cfg.user && cfg.pass) {
          const from = cfg.from || EMAIL_FROM;
          try {
            await sendMail({ host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass, from, to: toS, subject: subjS, body: bodyS });
            const f = `${dir}/email-${Date.now()}-sent.md`;
            fs.writeFileSync(f, `---\nto: ${toS}\nfrom: ${from}\nsubject: ${subjS}\nstatus: sent\nsentAt: ${new Date().toISOString()}\n---\n\n${bodyS}\n`);
            return harden({ ok: true, sent: true, to: toS, savedTo: f });
          } catch (e) {
            const f = `${dir}/email-${Date.now()}-FAILED.md`;
            fs.writeFileSync(f, `---\nto: ${toS}\nfrom: ${from}\nsubject: ${subjS}\nstatus: send-failed\nerror: "${String(e.message).replace(/[\r\n"]+/g, ' ')}"\n---\n\n${bodyS}\n`);
            return harden({ ok: false, sent: false, error: `SMTP send failed (saved as draft): ${e.message}`, savedTo: f });
          }
        }
        const f = `${dir}/email-${Date.now()}.md`;
        fs.writeFileSync(f, `---\nto: ${toS}\nsubject: ${subjS}\nstatus: reviewed-draft\n---\n\n${bodyS}\n`);
        return harden({ ok: true, sent: false, drafted: f, note: `Saved as a reviewed draft — no SMTP creds at ${EMAIL_CFG} yet.` });
      },
    }),
    subagent: Far('SubAgentExec', {
      help: () => 'Queues a sub-agent spawn proposal to the dashboard (a second human gate before anything with system access runs).',
      queue: async ({ name, task, powers }) => proposeSpawn({ agentName: 'field-agent', name: String(name || 'sub'), task: String(task || ''), caps: Array.isArray(powers) ? powers : [], prompt: '' }),
    }),
    // FULL-VM terminal: the COARSEST capability — basically root over the
    // agent-code persona's unix namespace (a kernel-isolated microVM that can't
    // reach the host or home LAN). exec() runs IMMEDIATELY: per dan, the grant IS
    // the authorization, not per-command confirm. Holding/being-granted `vm` is
    // the gate. Hand it to a developer delegate to build/run real software.
    vm: Far('TerminalExec', {
      help: () => `Terminal into the agent-code dev VM (${VM_HOST}). exec(cmd,{cwd}) runs immediately. Coarse authority — root over that sandbox namespace.`,
      describe: () => harden({ kind: 'terminal', host: VM_HOST }),
      exec: async (cmd, { cwd, timeoutMs = 60000 } = {}) => new Promise(resolve => {
        const full = cwd ? `cd ${JSON.stringify(String(cwd))} && ${String(cmd || '')}` : String(cmd || '');
        execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', VM_HOST, '--', 'bash', '-lc', full], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed, stdout: String(so || '').slice(0, 20000), stderr: String(se || '').slice(0, 8000) })));
      }),
    }),
    // HOST SHELL — the COARSEST capability in the system: a full `bash -lc` on THIS host
    // (archua) as the operator (dan), the same risk profile as claude-code with
    // --dangerously-skip-permissions. exec() runs IMMEDIATELY (the grant IS the authorization,
    // like `vm`). This is the #6 dogfood/dev harness: hand `host` to an iterating endo agent so
    // it can clone repos, run builds/tests/evals, and edit code on the host — equivalent to the
    // operator's own access. AMBIENT host-root authority: only grant it deliberately, and treat a
    // chat/share that holds it as holding the whole machine.
    host: Far('HostShell', {
      help: () => 'Full shell over THIS host (archua) as the operator. exec(cmd,{cwd}) runs immediately (the grant is the authorization). Coarse ambient host-root — clone/build/test/edit on the host. Equivalent to the operator\'s claude-code.',
      describe: () => harden({ kind: 'host-shell', host: 'archua (local)' }),
      // `jail` (optional) confines this shell to a worktree dir. When bwrap is available (WORKTREE_BWRAP)
      // the jail is a KERNEL boundary: only the worktree is bound rw, a read-only toolchain/repo is bound,
      // and the rest of the host (secrets, other state, write-elsewhere, network) is DENIED. Without bwrap
      // it degrades to a cwd-jail (race-isolation, escapable). Absent jail = unconfined host (trusted harness).
      exec: async (cmd, { cwd, timeoutMs = 300000, jail } = {}) => new Promise(resolve => {
        const done = (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed, stdout: String(so || '').slice(0, 40000), stderr: String(se || '').slice(0, 12000) }));
        const tmo = Math.min(Number(timeoutMs) || 300000, 600000);
        let startDir = process.env.HOME || '/home/dan';
        let effectiveCwd = cwd;
        if (jail) {
          startDir = jail;
          const j = resolveJailedCwd(jail, cwd);
          if (!j.ok) { resolve(harden({ ok: false, code: 1, killed: false, stdout: '', stderr: j.error })); return; }
          effectiveCwd = j.cwd === jail ? null : j.cwd; // null → run in the jail dir itself
          if (WORKTREE_BWRAP) {
            const args = [...BWRAP_BASE, '--bind', jail, jail, '--chdir', String(effectiveCwd || jail), '--', 'bash', '-lc', String(cmd || '')];
            execFile(BWRAP_BIN, args, { timeout: tmo, maxBuffer: 8 * 1024 * 1024 }, done);
            return;
          }
        }
        const full = effectiveCwd ? `cd ${JSON.stringify(String(effectiveCwd))} && ${String(cmd || '')}` : String(cmd || '');
        execFile('bash', ['-lc', full], { timeout: tmo, maxBuffer: 8 * 1024 * 1024, cwd: startDir }, done);
      }),
    }),
    // `delegate` is wired per-node (it needs the node's own sub-bundle builder),
    // so it is added in makeAgentNode, not here.
  });
};

// ── power metadata: name → label + the toolbox verbs it contributes ───────────
export const POWERS = harden({
  notes: { label: 'Read your personal notes', verbs: ['searchNotes', 'readNote'] },
  jotNote: { label: 'Jot NEW notes straight into your private vault (non-destructive — only ever ADDS; never overwrites or deletes; no confirmation)', verbs: ['addNote'] },
  reference: { label: 'Consult your library + Wikipedia', verbs: ['consult'] },
  web: { label: 'Search the web (Brave) + fetch & summarize a page', verbs: ['fetchUrl', 'webSearch'] },
  research: { label: 'Employ a research team (plan → parallel search/read/distill → cited synthesis)', verbs: ['research'] },
  youtube: { label: 'Transcribe a YouTube video (fetch its captions)', verbs: ['transcribeYoutube'] },
  images: { label: 'Generate images on the GPU', verbs: ['generateImage'] },
  feed: { label: 'Post to your feed + raise/read notifications + ask typed questions (the 🔔 inbox)', verbs: ['pushFeed', 'notify', 'listNotifications', 'askOperator'] },
  contact: { label: 'Message the owner — your back-channel to reach dan (inbox + phone)', verbs: ['messageOwner'] },
  connectors: { label: 'Call connected API services (tools the owner wired up; keys injected server-side)', verbs: ['listConnectors', 'callConnector'] },
  customtools: { label: 'Use admitted library tools (agent-built, owner-reviewed; sandboxed)', verbs: ['listCustomTools', 'callCustomTool'] },
  objects: { label: 'Accept Endo invite links into your inventory + call held objects (each accept is owner-confirmed)', verbs: ['proposeAcceptInvite', 'listObjects', 'callObject'] },
  phone: { label: 'Push a notification to your phone', verbs: ['pushPhone'] },
  timers: { label: 'Schedule wake-ups / reminders that PING dan (for things a human must do)', verbs: ['scheduleWakeup', 'repeatEvery', 'cancelTimer', 'listTimers'] },
  schedule: { label: 'Create + edit SCHEDULED TASKS — recurring autonomous runs that DO the work themselves on a cadence (use this, not a reminder, when the agent can do the task)', verbs: ['scheduleTask', 'listScheduledTasks', 'editScheduledTask', 'cancelScheduledTask'] },
  browser: { label: 'Browse the web in a real headless browser (render JS, read pages, screenshot)', verbs: ['browseWeb', 'screenshotWeb'] },
  home: { label: 'A private scratch/workspace folder of ITS OWN to read/write + publish sites + mint download links from (a sandboxed folder created for the agent — NOT your home directory or vault)', verbs: ['fileList', 'fileRead', 'fileWrite', 'publishSite', 'createDownloadLinkFor'] },
  vm: { label: 'Full terminal in the agent-code dev VM (coarse: root over that sandbox)', verbs: ['vmExec'] },
  host: { label: '⚠️ Full shell over THIS host (archua) as the operator — the dev/dogfood harness; coarse ambient host-root, like claude-code', verbs: ['hostExec'] },
  agents: { label: 'The roster of agent personas, machines + code sessions (read status; exec is coarse; full-VM machines also have a config checkout; route tasks to a dev session)', verbs: ['agentsList', 'agentStatus', 'agentExec', 'machineRepoStatus', 'machineRepoExec', 'routeToDev'] },
  selfPrompt: { label: 'Propose changes to your own system prompt (you confirm)', verbs: ['proposeSystemPrompt'] },
  delegate: { label: 'Delegate a task to a larger (Opus) agent', verbs: ['delegateTask'] },
  roles: { label: 'Employ a specialized role sub-agent (planner, retriever, synthesizer, critic, reviewer, …) with a least-privilege tool ring + model tier', verbs: ['listRoles', 'employ'] },
  // ── DESTRUCTIVE powers: the agent gets only `propose*` verbs. Each proposal
  //    is confirmed by the operator (root cap) before its real action fires. ──
  editNote: { label: 'Propose edits to your notes (you confirm)', verbs: ['proposeNoteEdit'] },
  homeassistant: { label: 'Read Home Assistant; propose device actions (you confirm)', verbs: ['haFind', 'haTree', 'haState', 'haAct'] },
  email: { label: 'Propose an email to send (you review + confirm)', verbs: ['proposeEmail'] },
  subagent: { label: 'Propose a sub-agent with system access (you confirm)', verbs: ['proposeSubAgent'] },
  contacts: { label: 'Read your address book; propose add/edit a contact (you confirm)', verbs: ['contactsSearch', 'contactsGet', 'proposeAddContact', 'proposeEditContact'] },
  specialists: { label: 'Spawn + consult persistent specialist sub-agents (spawning you confirm)', verbs: ['listSpecialists', 'proposeSpawnSpecialist', 'askSpecialist'] },
  kazputer: { label: 'Manage Kazputers — give someone a new one (email invite), and administer your own (settings/coins; you confirm)', verbs: ['proposeGiveKazputer', 'kazputerStatus', 'proposeKazputerSetting', 'proposeKazputerCoins'] },
  dietician: { label: "Drive the dietician's restaurant pipeline — scan an area, evaluate spots for Alexa's diet, refresh + publish the food guides (publishing you confirm)", verbs: ['dietScanArea', 'dietEvaluateArea', 'dietBuildMap', 'dietStatus', 'dietRefreshSite'] },
  app: { label: 'Introspect + manage your own app state — list/read/retitle every conversation (chats, voice memos, voice notes) and see an overview of asks/feed/proposals', verbs: ['listChats', 'readChat', 'retitleChat', 'appState'] },
  selfImprove: { label: '⚠️ Autonomously IMPLEMENT system improvements (FAPO-style: propose precise targets to a backlog → drain one → implement on an isolated worktree → independently verify → flag-gated auto-merge with post-merge re-verify + auto-revert)', verbs: ['improveSystem', 'proposeImprovement', 'listImprovements', 'runNextImprovement', 'listChangelog', 'revertChange'] },
});
export const ALL_POWERS = harden(Object.keys(POWERS));
harden(POWERS);
// A requested capability name may be a POWER ("selfPrompt") or a VERB ("proposeSystemPrompt") — the agent
// naturally asks for the verb it needs. Map either to the grantable POWER so requestAccess + the Grant UI
// name something the operator can actually grant (the #1 reason a power request wasn't surfaceable).
const VERB_TO_POWER = (() => { const m = {}; for (const [pw, def] of Object.entries(POWERS)) for (const v of (def.verbs || [])) m[v] = pw; return harden(m); })();
export const resolvePower = name => { const n = String(name || ''); return POWERS[n] ? n : (VERB_TO_POWER[n] || n); };

// ── build the agent. Returns the locator + a root node holding ALL powers. ────
// makeFieldAgent({ outDir, baseUrl }) →
//   { locator, register, rootNode, rootSwiss(set later), toolboxFor, manifestFor }
export const makeFieldAgent = ({ outDir, baseUrl, autoConfirmFile, specialistsFile, peerBridge = endoPeer, peerRedemption = process.env.FIELD_AGENT_PEER_REDEMPTION === '1' } = {}) => {
  const aff = makeAffordances({ outDir });
  // worktree manager for write-capable role sub-agents (runs on the UNCONFINED host shell).
  const worktrees = makeWorktrees({ host: aff.host });
  // ── the self-improvement loop: implement on an isolated worktree → INDEPENDENTLY verify → (flag-gated)
  //    auto-merge to the live branch with a post-merge re-verify + auto-revert. SELF_IMPROVE_AUTOMERGE=1
  //    enables the actual merge; default OFF = verify-and-stage a reviewable green branch (fail-safe). ──
  const SELF_IMPROVE_AUTOMERGE = process.env.SELF_IMPROVE_AUTOMERGE === '1';
  // verification command: a worktree checkout has no node_modules (gitignored + yarn-workspace links), so
  // symlink the live repo's node_modules levels into the checkout, then run the FULL voice-agent suite
  // against the worktree's CODE. Override with SELF_IMPROVE_VERIFY or a per-call successCommand.
  const DEFAULT_VERIFY = process.env.SELF_IMPROVE_VERIFY
    // `set -e` makes a failed symlink fatal (no silent run-without-deps); the test-file floor refuses a
    // change that deleted/stripped the very tests that gate it (else `node --test <glob>` matches 0 → exit 0).
    // BOOT SMOKE: `node --check` every top-level source .mjs (incl. server.mjs, which NO test imports) so a
    // syntax/parse error a merge would introduce can NEVER be recorded as verified + then brick the next
    // restart (the service is Restart=always — a broken boot = crash-loop that also kills the Revert UI).
    // PATH: ~/.local/bin holds yarn 4 (corepack); the systemd --user default PATH omits it, so without this
    // any yarn/corepack step in the implemented change (or a per-call successCommand) hits "command not found".
    || `export PATH="$HOME/.local/bin:$PATH"; set -e; for d in node_modules packages/chat/node_modules packages/chat/voice-agent/node_modules packages/ocapn-noise/node_modules; do if [ -d ${WORKTREE_REPO}/$d ]; then ln -sfn ${WORKTREE_REPO}/$d ./$d; fi; done; n=$(ls packages/chat/voice-agent/*.test.mjs 2>/dev/null | wc -l); [ "$n" -ge 8 ] || { echo "self-improve verify: only $n test files — refusing (the suite must not be stripped)"; exit 1; }; for f in packages/chat/voice-agent/*.mjs packages/ocapn-noise/*.mjs; do node --check "$f" || { echo "self-improve verify: SYNTAX ERROR in $f — refusing to merge a change that won't load"; exit 1; }; done; node --test packages/chat/voice-agent/*.test.mjs`;
  const selfImprover = makeSelfImprover({ host: aff.host, repo: WORKTREE_REPO, baseBranch: process.env.FIELD_AGENT_BASE_BRANCH || 'field-preact', verifyDir: `${WORKTREE_DIR}/_verify`, ledgerFile: '/home/dan/.local/state/field-agent/auto-merge-ledger.json', defaultTest: DEFAULT_VERIFY, timeoutMs: 600000 });
  let selfImproveInFlight = false; // single-flight: at most one self-improvement at a time
  // SELF-CONTAINED executor runner (does NOT require the `roles` power): fork a worktree, run the confined
  // executor (Opus) jailed to it, commit its working tree to a branch on teardown, return { branch }.
  const runWorktreeExecutor = async ({ goal, successCommand, signal } = {}) => {
    const spec = getRole('executor');
    const ring = [...new Set((spec.powers || []).filter(p => ALL_POWERS.includes(p) && !META_POWERS.has(p)))]; // host/home/web/research
    const wtId = `improve-${newSwiss().slice(0, 10)}`;
    let wt = null;
    try { wt = await worktrees.create(wtId); } catch (e) { return { branch: null, error: `worktree setup failed: ${String((e && e.message) || e)}` }; }
    let answer = ''; let branch = wt.branch; let committed = false;
    try {
      const subNode = makeAgentNode({ powers: ring, labelOf: `improve-exec-${wtId}`, haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null, cwdBinding: () => wt.dir, id: `improve-exec-${wtId}` });
      const sub = subNode.toolbox({ chatId: wtId });
      const verify = successCommand ? String(successCommand) : 'the full voice-agent test suite';
      const base = `${spec.prompt}\n\nYou are in a FRESH GIT WORKTREE checked out at the repo root — your hostExec runs THERE (relative paths land in the worktree). TASK:\n${String(goal)}\n\nThe change may be a single precise edit OR a LARGER ARCHITECTURAL change across SEVERAL files — whatever the task needs. HOW (do these with hostExec, do NOT just describe): (1) READ the relevant file(s) (\`cat\`/\`grep -rn\`) to understand the CURRENT code — reuse existing exports/helpers; do NOT invent a parallel API or rewrite working code; (2) WRITE each changed file to disk with a heredoc, e.g. \`cat > <path> <<'EOF'\\n…full new contents…\\nEOF\` (edit as many files as the change needs); (3) ALSO add/UPDATE the test(s) that encode the claim; (4) RUN the verification yourself — \`${verify}\` — and READ the output; if it is RED, fix until GREEN (do not finish red); (5) run \`git -C . diff --stat\` and confirm a NON-EMPTY diff. The change is merged ONLY if \`${verify}\` is green (re-verified independently) — the SUITE is the gate, not how many files you touched. Do NOT commit — the harness commits your working tree. Finish only once your own verification passed.`;
      const dirtyNow = async () => { const d = await aff.host.exec(`git -C ${shq(wt.dir)} status --porcelain`, { timeoutMs: 30000 }); return !!(d.ok && String(d.stdout || '').trim()); };
      let r = await runOpusDelegate({ prompt: base, toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: ring, signal, maxSteps: 22 });
      if (process.env.DEBUG_EXECUTOR) console.error('[exec dbg] r=', JSON.stringify({ error: r?.error, answer: String(r?.answer || '').slice(0, 200), toolsUsed: (r?.toolsUsed || []).map(t => t.name), wtDir: wt?.dir }));
      answer = (r && r.answer) || '';
      // FAPO iterate-with-feedback: if NOTHING changed on disk, push back ONCE and retry — narrating ≠ editing.
      if (!(await dirtyNow())) {
        r = await runOpusDelegate({ prompt: `${base}\n\n⚠️ RETRY — you changed NO files on disk last attempt; describing the change is not enough. Use hostExec NOW to actually write the file(s) and the test (cat the file, then write the edited contents back with a heredoc), then confirm a non-empty \`git -C . diff --stat\`.`, toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: ring, signal, maxSteps: 22 });
        answer = `${answer}\n[retry] ${(r && r.answer) || ''}`.slice(0, 8000);
      }
    } catch (e) { answer = `executor error: ${String((e && e.message) || e)}`; } // ANY failure → still tear down (no worktree leak)
    finally {
      try { const t = await worktrees.teardown(wtId, { commitMessage: `self-improve: ${String(goal).slice(0, 72)}` }); branch = (t && t.branch) || branch; committed = !!(t && t.committed); } catch { /* keep wt.branch */ }
      // no empty leftover: if nothing was committed, delete the (base-pointing) branch the worktree created.
      if (!committed && branch) { try { await aff.host.exec(`git -C ${shq(WORKTREE_REPO)} branch -D ${shq(branch)} 2>/dev/null`, { timeoutMs: 15000 }); } catch { /* best effort */ } }
    }
    // if the executor made NO change, the teardown committed nothing → report no branch (honest no-op).
    return { branch: committed ? branch : null, answer, committed };
  };
  // locator: swissnum → { node }  (every entry is an agent-node; the root and
  // every shared sub-bundle are nodes, so any holder can manage what it holds).
  const locator = new Map();

  // The HomeAssistant object trie (built lazily by buildHomeAssistant at boot).
  // The root agent's HA binding is the whole trie; an HA share's binding is a
  // sub-node. Designation is the held node + its web-key handles, never a string.
  let haTrie = null;
  let agentRoster = null; // the agent-personas roster object trie (built at boot)
  let contactsObj = null; // dan's NextCloud address book (CardDAV), built at boot
  const connectorsObj = makeConnectors({ getSecret, ssrfOk }); // owner-configured API-service tools (key injected server-side)
  const customToolsObj = makeCustomTools(); // agent-PROPOSED, human-reviewed code tools (admitted → callable, SES-sandboxed)
  const toolSharesObj = makeToolShares({ dir: '/home/dan/.local/state/voice-agent/tool-shares' }); // same store the server consumer-routes read
  const componentGitObj = makeComponentGit({ baseDir: '/home/dan/.local/state/voice-agent/component-git' }); // a component's source as a git-as-Endo object (version/fork/revert)
  let kazAdmin = null; // admin object for dan's own Kazputer (kid-phone), built at boot — searchable + actionable

  // ── virtual home folders + static site publishing ──────────────────────────
  // Every agent that holds the `home` power gets a home folder object bound to
  // its own sub-dir. publish() registers a folder as a static site under
  // /sites/<token>/ (an unguessable web-key path) and returns the URL.
  // PERSISTED (token → absolute dir) so a published-site link keeps working across a restart — the site's
  // content lives under HOME_BASE (durable); only this mapping was volatile, which 404'd every prior /sites
  // link on each restart ("unknown or revoked site"). Tokens are web-keys → file mode 0600.
  const SITES_FILE = `${outDir}/site-refs.json`;
  const sites = new Map();
  try { const d = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) sites.set(k, v); } catch { /* none yet */ }
  const saveSites = () => { try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(SITES_FILE, JSON.stringify(Object.fromEntries(sites)), { mode: 0o600 }); } catch { /* best-effort */ } };
  const publish = async (dir, name) => { const token = crypto.randomBytes(8).toString('hex'); sites.set(token, dir); saveSites(); return { name: String(name || 'site'), url: `${baseUrl}/sites/${token}/`, token }; };
  // download web-keys: token → { path (canonical, inside an agent home), name }. The token IS the credential
  // (like /sites, /uploads). 36-hex so it dodges the bare-32-hex trace scrub — a download link is a legit
  // render (it serves ONE file as an attachment), not a cap to the agent's authority. In-memory, like sites.
  // PERSISTED so a download link handed to the user keeps working across a service restart (in-memory-only
  // meant every restart silently 404'd every prior link). Tokens are web-keys → file mode 0600. Bounded.
  const DOWNLOADS_FILE = `${outDir}/download-refs.json`;
  const downloads = new Map();
  try { const d = JSON.parse(fs.readFileSync(DOWNLOADS_FILE, 'utf8')); if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) downloads.set(k, v); } catch { /* none yet */ }
  const saveDownloads = () => { try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(DOWNLOADS_FILE, JSON.stringify(Object.fromEntries(downloads)), { mode: 0o600 }); } catch { /* best-effort */ } };
  const download = async (absFile, name) => {
    const token = crypto.randomBytes(18).toString('hex'); const nm = String(name || 'download').slice(0, 200);
    downloads.set(token, { path: absFile, name: nm });
    if (downloads.size > 2000) downloads.delete(downloads.keys().next().value); // bound the store (oldest out)
    saveDownloads();
    return { name: nm, url: `/dl/${token}`, token };
  };
  const downloadFor = token => downloads.get(String(token || '')) || null;
  const homeCache = new Map(); // subkey → home object (stable per agent)
  const makeHome = subkey => { if (!homeCache.has(subkey)) homeCache.set(subkey, makeHomeFolder({ root: `${HOME_BASE}/${subkey}`, label: subkey, publish, download })); return homeCache.get(subkey); };

  // The agent's editable system-prompt block (persisted; injected into runAgent).
  // Changes are operator-confirmed proposals — the agent can PROPOSE but not apply.
  let persona = '';
  try { persona = fs.readFileSync(PERSONA_FILE, 'utf8'); } catch {}
  const writePersona = t => { try { fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true }); fs.writeFileSync(PERSONA_FILE, String(t ?? ''), { mode: 0o600 }); persona = String(t ?? ''); return harden({ ok: true, bytes: persona.length }); } catch (e) { return harden({ ok: false, error: e.message }); } };

  // ── proposal registry: destructive actions become confirmable proposals ──────
  // propose() stores the full detail + the real commit() closure SERVER-SIDE and
  // returns a SLIM record to the agent (no detail) — so the prompt stays small
  // and the agent never holds the executor. The agent can only create a pending
  // proposal; commit()/reject() are operator-only (root-cap-gated in the server).
  // In-memory: a restart clears pending proposals (they're transient confirmations).
  const proposals = new Map(); // id → { id, type, power, title, summary, detail, status, commit, createdAt }
  const newPid = () => `p-${crypto.randomBytes(5).toString('hex')}`;
  const propose = ({ type, power, title, summary, detail, commit, agent = 'root' }) => {
    // "don't ask again": a recorded (agent, kind) rule fires immediately, mid-turn,
    // so an autonomous specialist can chain actions. Returns a Promise on this path.
    if (isAutoConfirmed(agent, type)) {
      return Promise.resolve().then(() => commit()).then(
        result => harden({ autoConfirmed: true, fired: true, type, power, title, summary, result }),
        e => harden({ autoConfirmed: true, fired: false, type, power, title, error: e.message }),
      );
    }
    const id = newPid();
    proposals.set(id, { id, type, power, agent, title, summary, detail, status: 'pending', commit, createdAt: new Date().toISOString() });
    return harden({ proposed: true, id, type, title, summary }); // detail stays server-side
  };
  const getProposal = id => { const p = proposals.get(String(id)); return p ? harden({ id: p.id, type: p.type, power: p.power, agent: p.agent, title: p.title, summary: p.summary, detail: p.detail, status: p.status, createdAt: p.createdAt }) : null; };
  const commitProposal = async (id, { rememberKind = false } = {}) => {
    const p = proposals.get(String(id));
    if (!p) return harden({ ok: false, error: 'unknown proposal' });
    if (p.status !== 'pending') return harden({ ok: false, error: `already ${p.status}` });
    try {
      const result = await p.commit();
      p.status = 'confirmed';
      // "don't ask again" → record a (creating-agent, kind) auto-confirm rule
      if (rememberKind) addAutoRule(p.agent || 'root', p.type);
      return harden({ ok: true, type: p.type, title: p.title, result, remembered: !!rememberKind && !NEVER_AUTO.has(p.type) });
    } catch (e) { p.status = 'error'; return harden({ ok: false, error: e.message }); }
  };
  const rejectProposal = id => {
    const p = proposals.get(String(id));
    if (!p) return harden({ ok: false, error: 'unknown proposal' });
    if (p.status !== 'pending') return harden({ ok: false, error: `already ${p.status}` });
    p.status = 'rejected'; return harden({ ok: true });
  };

  // ── "DON'T ASK AGAIN" auto-confirm rules (the trust layer between propose and
  //    execute). A rule (agent, kind) lets that agent's proposals of that kind FIRE
  //    immediately instead of parking a confirmation card. Rules are recorded ONLY
  //    when the operator confirms WITH "don't ask again", keyed to the agent that
  //    created the proposal (root, or a specialist), and are revocable from that
  //    agent's inventory. Persisted so the accrued trust survives restarts.
  //    HomeAssistant is EXCLUDED — physical-world actions (locks!) always confirm;
  //    per-entity HA autonomy is future work needing per-cap attribution. ──────────
  const AUTOCONFIRM_FILE = autoConfirmFile || '/home/dan/.config/field-agent/auto-confirm.json';
  const NEVER_AUTO = new Set(['home-assistant', 'spawn-specialist', 'accept-invite']); // physical-world + authority-granting actions ALWAYS confirm
  let autoRules = [];
  try { autoRules = JSON.parse(fs.readFileSync(AUTOCONFIRM_FILE, 'utf8')).rules || []; } catch { autoRules = []; }
  const saveAutoRules = () => { try { fs.mkdirSync(path.dirname(AUTOCONFIRM_FILE), { recursive: true }); fs.writeFileSync(AUTOCONFIRM_FILE, JSON.stringify({ rules: autoRules }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };
  const isAutoConfirmed = (agent, kind) => !NEVER_AUTO.has(kind) && autoRules.some(r => r.agent === agent && r.kind === kind);
  const addAutoRule = (agent, kind) => { if (NEVER_AUTO.has(kind)) return; if (!autoRules.some(r => r.agent === agent && r.kind === kind)) { autoRules.push({ agent, kind, since: new Date().toISOString() }); saveAutoRules(); } };
  const removeAutoRule = (agent, kind) => { const before = autoRules.length; autoRules = autoRules.filter(r => !(r.agent === agent && r.kind === kind)); if (autoRules.length !== before) saveAutoRules(); return before !== autoRules.length; };
  const listAutoRules = agent => autoRules.filter(r => agent == null || r.agent === agent).map(r => harden({ agent: r.agent, kind: r.kind, since: r.since }));

  // ── SPECIALISTS: persistent named sub-agents the entry agent spawns INTO ITS OWN
  //    inventory. Each holds a confined power bundle (⊆ the spawner's, minus the
  //    meta-powers so it can't recursively spawn), its own instructions (persona),
  //    and its own stable id — so its proposals are scoped to IT and it earns
  //    autonomy per-kind via the "don't ask again" rules above. Spawning is itself a
  //    confirmable proposal (the grant is the authorization). Persisted so a
  //    specialist + its accrued context survive restarts. ─────────────────────────
  const SPECIALISTS_FILE = specialistsFile || '/home/dan/.config/field-agent/specialists.json';
  const META_POWERS = new Set(['delegate', 'subagent', 'specialists', 'roles', 'app', 'selfImprove']); // orchestration + self-state powers — not delegable/shareable downward (one level deep; `app` is root-only; `selfImprove` is implement-mode-scheduled-only — never a sub-bundle or share)
  let specialists = [];
  try { specialists = JSON.parse(fs.readFileSync(SPECIALISTS_FILE, 'utf8')).specialists || []; } catch { specialists = []; }
  const saveSpecialists = () => { try { fs.mkdirSync(path.dirname(SPECIALISTS_FILE), { recursive: true }); fs.writeFileSync(SPECIALISTS_FILE, JSON.stringify({ specialists }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };

  // ── BUILT-IN AGENTS — curated, code-defined domain agents (the Dietician, …). They behave EXACTLY like
  //    specialists (a confined power-ring + a persona you can "act as" from the header / Settings, or consult
  //    via askSpecialist) but are ALWAYS present and are NOT persisted into the user's specialists store. Each
  //    is a subset of ALL_POWERS minus the meta powers. Edit this list to curate the menu.
  const BUILTIN_AGENTS = [
    { id: 'dietician', name: '🥗 Dietician', domain: 'restaurant + diet safety', powers: ['dietician', 'web', 'reference', 'notes', 'jotNote', 'contact', 'feed'],
      instructions: [
        "You are the Dietician — the household's restaurant + diet-safety agent, powered by a built-in scanning PIPELINE. To find + add restaurants for ANY place, ALWAYS use the pipeline tools — do NOT manually web-search to discover or compile a restaurant list:",
        "1. dietScanArea(city) — sweeps an area's restaurants. It works for ANY city, including ones never scanned before: a NEW city (e.g. Copenhagen) is auto-geocoded, so just call it with the city name. It returns candidate restaurants. (If it returns no candidates, SAY SO and double-check the city name — never silently fall back to a hand-made list.)",
        "2. dietEvaluateArea(city) — judges the scanned candidates against the person's diet spec (VIABLE / BORDERLINE / SKIP / UNKNOWN), finding each menu. Run it in batches until done.",
        "3. dietBuildMap() — rebuilds the safe-eats map. dietRefreshSite(site) — refreshes a published food guide (propose→confirm; NEVER publish without confirmation).",
        "The official safe-eats map + guides come ONLY from this pipeline. Use web / reference ONLY to look up a SPECIFIC restaurant's menu or answer a diet question — never to invent a restaurant list.",
        "The family's diet specs live in the vault's Dietician folder: [[Alexa — Diet]] and [[Dan — Diet]] (index: [[Diet Preferences]]). Read them for context. If dan changes a preference (e.g. \"more gluten while in Europe\"), note it in that folder and call it out — that is where the family edits its diet rules.",
        "Be skeptical about menus; when unsure prefer SKIP / UNKNOWN. Carry the city + person across the conversation.",
      ].join('\n') },
    { id: 'researcher', name: '🔎 Researcher', domain: 'deep multi-source research', powers: ['research', 'web', 'reference', 'browser', 'notes', 'jotNote', 'feed'],
      instructions: 'You are the Researcher. For any question, plan, search the web + your library in parallel, read the best sources, and synthesize a concise, CITED answer. Prefer primary sources and flag uncertainty. Use the research tool for big questions; web/browser/reference for the rest; jot durable findings to notes.' },
    { id: 'home', name: '🏠 Home', domain: 'Home Assistant', powers: ['homeassistant', 'notes', 'feed'],
      instructions: 'You are the Home agent for Home Assistant. Find devices/rooms, read their state, and propose device actions (every action is propose→confirm). Be precise about which entity you mean and confirm the room/device before acting.' },
    { id: 'scheduler', name: '⏰ Scheduler', domain: 'reminders + recurring tasks', powers: ['timers', 'schedule', 'contact', 'feed', 'notes'],
      instructions: 'You are the Scheduler. Set reminders + recurring tasks: scheduleWakeup/repeatEvery for things a human must do (these ping dan), scheduleTask for recurring work an agent can do itself. List + cancel jobs on request, and confirm the cadence + what will fire.' },
    { id: 'image-studio', name: '🎨 Image studio', domain: 'image generation', powers: ['images', 'home', 'feed'],
      instructions: 'You are the Image Studio. Generate + restyle images on the GPU from a prompt. Offer a couple of variations, and save outputs to the home folder when asked.' },
    // The meta-agent: it BUILDS other specialists. It is curated, so it may hold the `specialists` meta power
    // (built-ins are owner-defined). It edits its OWN prompt via proposeSystemPrompt (routed per-agent below).
    { id: 'specialist-builder', name: '🧩 Specialist Builder', domain: 'designing + spawning specialist agents', powers: ['specialists', 'selfPrompt', 'notes', 'jotNote', 'reference'],
      instructions: [
        'You are the Specialist Builder — you help dan design, spawn, and refine SPECIALIST sub-agents.',
        '',
        'WHAT A SPECIALIST IS: a persistent, confined sub-agent of Agent C with a short id + display name, a DOMAIN (the kind of requests it handles), a POWER RING (a subset of Agent C\'s powers — its least-authority tool bundle), and standing INSTRUCTIONS (its persona). It has its own invite link; its proposals + auto-confirm rules are scoped to its id; it runs on the local model by default. You consult one with askSpecialist, and the user can also pick it from the agent menu and chat with it directly.',
        '',
        'HOW TO DESIGN A GOOD ONE:',
        '1. Scope it to ONE clear domain — a specialist that does one job well beats a vague generalist.',
        '2. Grant the MINIMAL power ring (least authority): only the powers the job actually needs. Fewer powers = safer + more predictable. (Meta powers — delegate, subagent, specialists, roles, app, selfImprove — CANNOT be granted to a specialist; that is by design, to bound delegation one level deep.)',
        '3. Write clear standing instructions: its role, what it does step by step, when to PROPOSE vs act, and any skepticism/safety rules for its domain. Destructive actions stay propose→confirm regardless.',
        '4. Name it for what it does, with a fitting emoji.',
        '',
        'THE FLOW: talk through the need with dan → decide the domain + the minimal powers + the instructions → proposeSpawnSpecialist({ name, domain, powers, instructions }) (dan confirms the grant) → test it with askSpecialist → refine its instructions if needed. Use listSpecialists first; don\'t duplicate one that exists.',
        '',
        'EXAMPLES already in the menu (built-in domain agents): 🥗 Dietician, 🔎 Researcher, 🏠 Home, ⏰ Scheduler, 🎨 Image studio — study their shape (focused domain + a tight power ring + a clear persona).',
        '',
        'KEEP LEARNING: when you discover what makes a specialist work well (or badly), jot the lesson to notes, and refine your OWN prompt with proposeSystemPrompt (that edits YOUR instructions; dan confirms) so you get better at this over time. ocap discipline always: designate by reference, grant least authority, the cap is the boundary.',
      ].join('\n') },
  ];
  // built-ins are owner-curated, so their declared powers are honored as-is (META powers ALLOWED for them —
  // e.g. the Specialist Builder holds `specialists`); only invalid power names are dropped.
  const builtinSpecs = BUILTIN_AGENTS.map(a => harden({
    id: a.id, name: a.name, domain: a.domain,
    powers: [...new Set(a.powers.filter(p => ALL_POWERS.includes(p)))],
    instructions: a.instructions, builtin: true, spawnedFrom: null,
  }));
  const builtinList = () => builtinSpecs.map(s => ({ id: s.id, name: s.name, domain: s.domain, powers: s.powers, autonomy: [], spawnedFrom: null, builtin: true }));

  // per-built-in persona OVERRIDES — so a built-in agent (the Specialist Builder, …) can edit its OWN prompt at
  // runtime. proposeSystemPrompt routes here by the acting node id; falls back to the code instructions.
  const BUILTIN_PERSONAS_FILE = path.join(path.dirname(SPECIALISTS_FILE), 'builtin-personas.json');
  let builtinPersonas = {};
  try { builtinPersonas = JSON.parse(fs.readFileSync(BUILTIN_PERSONAS_FILE, 'utf8')) || {}; } catch { builtinPersonas = {}; }
  const isBuiltinId = id => builtinSpecs.some(s => s.id === id);
  const builtinPersona = id => builtinPersonas[id] || (builtinSpecs.find(s => s.id === id) || {}).instructions || '';
  const setBuiltinPersona = (id, text) => { try { builtinPersonas[id] = String(text ?? ''); fs.mkdirSync(path.dirname(BUILTIN_PERSONAS_FILE), { recursive: true }); fs.writeFileSync(BUILTIN_PERSONAS_FILE, JSON.stringify(builtinPersonas, null, 2), { mode: 0o600 }); return harden({ ok: true, bytes: builtinPersonas[id].length }); } catch (e) { return harden({ ok: false, error: e.message }); } };
  // Per-chat scoped caps must SURVIVE RESTARTS (else a deployed/restarted server orphans every
  // confined chat — its cap 403s, the chat silently can't send). Persist {swiss, powers, label}
  // and re-register at boot, the same durability the root swiss already has.
  const SCOPED_FILE = '/home/dan/.config/field-agent/scoped-caps.json';
  let scopedCaps = [];
  try { scopedCaps = JSON.parse(fs.readFileSync(SCOPED_FILE, 'utf8')).caps || []; } catch { scopedCaps = []; }
  const saveScoped = () => { try { fs.mkdirSync(path.dirname(SCOPED_FILE), { recursive: true }); fs.writeFileSync(SCOPED_FILE, JSON.stringify({ caps: scopedCaps }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };
  // ── INVENTORY: external Endo capabilities the agent ACCEPTED (each via an owner-confirmed proposal) — the
  //    inbound counterpart to createInvite. The swissnum is held host-side (mode 0600), NEVER spoken/rendered;
  //    the object is called over the standard /rpc {swissnum, method, args} seam (the same one createInvite shares).
  const OBJECTS_FILE = process.env.OBJECTS_FILE || '/home/dan/.config/field-agent/accepted-objects.json'; // env-overridable for tests
  let acceptedObjects = [];
  try { acceptedObjects = JSON.parse(fs.readFileSync(OBJECTS_FILE, 'utf8')).objects || []; } catch { acceptedObjects = []; }
  const saveAcceptedObjects = () => { try { fs.mkdirSync(path.dirname(OBJECTS_FILE), { recursive: true }); fs.writeFileSync(OBJECTS_FILE, JSON.stringify({ objects: acceptedObjects }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };
  // Parse an invite into { origin (HTTP only), swissnum, transport, address }. A non-HTTP scheme (iroh://,
  // ocapn://) has no HTTP origin — `new URL(...).origin` returns the STRING "null", which used to be stored
  // and then dialed as `fetch("null/rpc")` (the "Failed to parse URL from null/rpc" bug). We now keep origin
  // EMPTY for those and record the real transport + address, so callObject can fail legibly instead.
  const parseInvite = link => {
    const s = String(link || '').trim();
    const m = /#(?:cap|agent)=([0-9a-fA-F]{16,})/.exec(s) || /(?:^|[^0-9a-f])([0-9a-f]{32,128})(?:[^0-9a-f]|$)/.exec(s);
    if (!m) return null;
    let origin = '', transport = '', address = '';
    // Detect the scheme by REGEX (not new URL — a complex endo://…?at=iroh+captp0://… invitation makes new URL
    // throw, which used to drop the scheme and mis-treat it as a same-instance link). http(s) → an origin;
    // any other scheme (iroh / endo / ocapn) → keep the raw link as the dialable address; no scheme → relative.
    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(s) || [])[1] || '';
    if (/^https?$/i.test(scheme)) { try { origin = new URL(s.split('#')[0]).origin; } catch { /* */ } }
    else if (scheme) { transport = scheme.toLowerCase(); address = s.split('#')[0]; }
    return { origin, swissnum: m[1], transport, address };
  };
  // Call an accepted object's /rpc. HTTP origin → that origin; empty origin → THIS instance (a same-instance
  // invite). A truthy-but-non-HTTP origin (legacy "null", or an iroh/ocapn ref) is NOT HTTP-reachable → return
  // a legible error rather than fetching a garbage URL or silently hitting our own /rpc with a foreign swissnum.
  const rpcCall = async (origin, swissnum, method, args) => {
    let base;
    if (origin && /^https?:\/\//.test(origin)) base = origin;
    else if (!origin) base = baseUrl;
    else return { error: `cannot reach this object over HTTP — its origin "${origin}" is not an HTTP endpoint (it's an endo-iroh/ocapn reference; that dial-by-pubkey transport is not wired into this app yet). Re-accept the invite once the Iroh transport lands.` };
    try { return await (await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum, method: String(method || 'describe'), args: Array.isArray(args) ? args : (args == null ? [] : [args]) }) })).json(); } catch (e) { return { error: e.message }; } };
  // An accepted object is HTTP-callable iff it has no non-HTTP transport AND its origin is same-instance ('')
  // or a real http(s) origin (NOT the legacy stored string "null"). iroh/ocapn refs are held but not callable.
  const isHttpCallable = o => (!o.transport || o.transport === 'http') && (!o.origin || o.origin === '(this instance)' || /^https?:\/\//.test(String(o.origin)));
  // An iroh ref is dialable iff it carries an iroh transport AND a real iroh://… address. (A LEGACY
  // origin:"null" record with no transport/address is NOT a real iroh ref — it stays not-callable.)
  const isIrohCallable = o => o.transport === 'iroh' && /^iroh:\/\//i.test(String(o.address || ''));
  // A redeemed Endo peer (an accepted endo://…?type=invitation) is reachable as a mailbox via the peer-daemon.
  const isPeerCallable = o => o.transport === 'endo-peer' || o.peer === true;
  // ── NATIVE-ENDO inventory: an accepted object is exposed to the agent as a LIVE in-scope object whose methods
  //    it calls directly (await Kumavis.send('hi')) — NOT via callObject(name,'method',args) string dispatch.
  //    routeObjectCall is the ONE internal router (the method string lives HERE, never in agent-authored code);
  //    presenceFor wraps it into a real object; methodsOfObject documents the one-layer method set. callObject
  //    remains only as the introspection/bootstrap escape hatch for objects whose methods aren't known yet. ──
  const sanitizeIdent = s => { let n = String(s || '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^_+|_+$/g, ''); if (!n) n = 'obj'; if (/^[0-9]/.test(n)) n = `o_${n}`; return n.slice(0, 40); };
  const methodsOfObject = o => {
    if (o.transport === 'endo-peer' || o.peer) return [
      { name: 'send', args: { text: 'string — your message' }, description: 'message this peer' },
      { name: 'inbox', args: {}, description: 'read messages/replies they have sent you' },
      { name: 'describe', args: {}, description: 'what this object is + its methods' }];
    const ms = (Array.isArray(o.methods) ? o.methods : []).map(x => typeof x === 'string' ? x : (x && x.name)).filter(Boolean);
    return (ms.length ? ms : ['describe']).map(n => ({ name: n, args: {}, description: '' }));
  };
  // Route one method call on an accepted object to its transport. Returns { ok, value } | { ok:false, error, terminal? }.
  const routeObjectCall = async (o, method, argList) => {
    const m = String(method || 'describe');
    const args = Array.isArray(argList) ? argList : (argList == null ? [] : [argList]);
    if (o.transport === 'endo-peer' || o.peer) {
      const lm = m.toLowerCase();
      if (lm === 'describe' || lm === 'help') return { ok: true, value: { kind: 'endo-peer', name: o.name, summary: 'A live Endo PEER (a mailbox): send(text) to message them; inbox() to read their replies.', methods: { send: 'send(text)', inbox: 'inbox()', describe: 'this' } } };
      if (lm === 'send' || lm === 'message' || lm === 'tell') { const a = args[0]; const text = typeof a === 'string' ? a : (a && (a.text || a.message)) || ''; if (!text) return { ok: false, error: 'send needs a message string' }; try { await peerBridge.sendToPeer(o.name, String(text)); return { ok: true, value: `message sent to "${o.name}"` }; } catch (e) { return { ok: false, error: `couldn't message "${o.name}" over iroh: ${e.message}` }; } }
      if (lm === 'inbox' || lm === 'messages' || lm === 'read' || lm === 'listmessages') { try { const r = await peerBridge.peerInbox({}); return { ok: true, value: r.messages }; } catch (e) { return { ok: false, error: `couldn't read the inbox for "${o.name}": ${e.message}` }; } }
      return { ok: false, error: `"${o.name}" is a live peer (a mailbox): use send / inbox / describe.` };
    }
    if (isIrohCallable(o)) { const r = await dialIrohObject({ address: o.address, swissnum: o.swissnum, method: m, args }); return r.ok ? { ok: true, value: r.value } : { ok: false, error: `couldn't reach "${o.name}" over iroh: ${r.error}` }; }
    if (/^endo:\/\//i.test(String(o.address || '')) || /type=invitation/i.test(String(o.address || ''))) return { ok: false, terminal: true, error: `"${o.name}" is an Endo daemon invitation stored before redemption support — ask the user to re-accept it to redeem it as a live peer. FINAL: report it, don't retry.` };
    if (!isHttpCallable(o)) return { ok: false, terminal: true, error: `"${o.name}" is not callable (transport=${o.transport || 'none'}). FINAL — report it, don't retry.` };
    try { return { ok: true, value: await rpcCall(o.origin, o.swissnum, m, args) }; } catch (e) { return { ok: false, error: e.message }; }
  };
  // A real in-scope object for an accepted inventory entry: each known method calls routeObjectCall. The method
  // name is captured in the closure (here), so the agent writes `await Name.method(args)` with NO method string.
  const presenceFor = o => { const obj = {}; for (const m of methodsOfObject(o)) obj[m.name] = harden(async (a) => { const r = await routeObjectCall(o, m.name, a === undefined ? [] : [a]); if (!r || r.ok === false) throw new Error((r && r.error) || 'call failed'); return r.value; }); return harden(obj); };
  // ── PER-CHAT "located objects" working set: the HA devices the agent has found/read/acted on THIS chat.
  //    Carried across turns + bound next turn as a LIVE in-scope object, so a follow-up ("have it go clean")
  //    acts on the SAME device by name (await Roborock.act({action:'start'})) without re-discovering it. The
  //    node's c-list already persists the AUTHORITY for the handle; this carries the agent's KNOWLEDGE of it. ──
  const locatedByChat = new Map(); // chatId → Map(handle → { handle, name, state })
  const recordLocated = (chatId, ent) => {
    if (!chatId || !ent || !ent.handle) return;
    let m = locatedByChat.get(chatId); if (!m) { m = new Map(); locatedByChat.set(chatId, m); }
    const prev = m.get(ent.handle) || {}; m.delete(ent.handle); // re-insert → most-recent
    m.set(ent.handle, { handle: ent.handle, name: ent.name || prev.name || ent.handle, state: ent.state || prev.state || '' });
    while (m.size > 12) m.delete(m.keys().next().value); // cap to the 12 most-recently-touched
  };
  // a live in-scope object for a located HA entity: state() reads (free), act() PROPOSES (operator confirms).
  const haEntityPresence = (nd, e) => harden({
    state: harden(async () => { const n = nd.haReach(e.handle); if (!n || !n.state) return { ok: false, error: `"${e.name}" is no longer in reach — haFind it again` }; return { ok: true, ...(await n.state()) }; }),
    act: harden(async (a = {}) => { const n = nd.haReach(e.handle); if (!n || !n.act) return { ok: false, error: `"${e.name}" is not actuable / not in reach — haFind it again` }; try { return n.act(String((a && a.action) || ''), (a && a.data) || {}); } catch (err) { return { ok: false, error: err.message }; } }),
  });
  const specSlug = name => `spec-${String(name || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x'}`;
  const findSpecialist = ref => { const r = String(ref || ''); return specialists.find(s => s.id === r || s.id === specSlug(r) || s.name.toLowerCase() === r.toLowerCase()) || builtinSpecs.find(s => s.id === r || s.name.toLowerCase() === r.toLowerCase()); };
  const specNodes = new Map(); // id → its agent-node (built lazily / at boot)

  // a run-context (ctx) is threaded into the verbs at toolbox-build time; the only
  // field today is chatId — the chat the agent is acting in. Notifications/pushes
  // auto-append a deep-link to that chat (no swissnum in the link — cap-hygiene).
  const chatLink = ctx => (ctx && ctx.chatId) ? `${baseUrl}/#chat=${encodeURIComponent(String(ctx.chatId))}` : '';

  // The toolbox verbs (the LLM's reach), implemented once. Each maps to an
  // affordance method. createInvite + delegateTask are bound per-node below.
  const baseVerb = harden({
    searchNotes: { reversible: false, args: { query: 'string' }, description: 'Search your personal notes; returns matches.',
      run: async ({ query }, agent, ctx = {}) => (ctx.notes || aff.notes).search(String(query || ''), { limit: 6 }) },
    // ── INVENTORY (the `objects` power): accept an Endo invite link → a named object you can call. The
    //    inbound counterpart to createInvite. Accepting external authority ALWAYS confirms (NEVER_AUTO).
    proposeAcceptInvite: { reversible: false, args: { link: 'string — the Endo invite / #cap= link to accept', name: 'string — what to CALL this object in your inventory (if the user has not named it, ASK them first)', description: 'string — what the object is / does' },
      description: 'ACCEPT an Endo invite link and add the capability it grants as a NAMED object in your inventory. Handles three link kinds: an http /rpc object, an iroh:// dial-by-pubkey object, and a full Endo daemon INVITATION (endo://…?type=invitation) — the last is REDEEMED over iroh+captp0 into a live PEER (a mailbox relationship: callObject "send" to message them, "inbox" to read replies). Does NOT add it yet — it PROPOSES it for the owner to confirm (they can rename it); accepting external authority always confirms. Once accepted, discover + call it with callObject (method "describe" lists its methods). The link/swissnum is held securely host-side, never shown.',
      run: async ({ link, name, description }, agent) => {
        const parsed = parseInvite(link); if (!parsed) return { ok: false, error: 'that does not look like an Endo invite / #cap= link' };
        // Endo daemon invitation redemption (over iroh+captp0) is gated until the iroh netlayer's connection
        // lifecycle is proven reliable — flip FIELD_AGENT_PEER_REDEMPTION=1 once the gated e2e is green. Until
        // then a type=invitation link reports cleanly (terminal, no daemon spawn, no loop) instead of flaking.
        if (/type=invitation/i.test(String(link)) && !peerRedemption) return { ok: false, terminal: true, error: `"${String(name || 'this').trim()}" is an Endo daemon invitation. Redeeming it over iroh+captp0 is implemented but not yet ENABLED on this instance (a final iroh-netlayer reliability fix is landing). I can't connect to this peer yet — I'll be able to shortly. This is FINAL: report it and stop, don't retry.` };
        // Pre-WARM the peer-daemon sidecar while the owner reads the proposal, so the actual redemption on
        // Confirm dials from an already-up (relay-connected) sidecar rather than cold. Fire-and-forget.
        if (/type=invitation/i.test(String(link))) { try { peerBridge.ensurePeerDaemon().catch(() => {}); } catch { /* best-effort warm-up */ } }
        const nm = String(name || '').trim() || 'new object';
        const whence = parsed.origin || (parsed.transport ? `${parsed.transport} (${parsed.address})` : 'this instance');
        return propose({ type: 'accept-invite', power: 'objects', agent, title: `Accept invite → "${nm}"`, summary: `from ${whence}`,
          detail: { name: nm, origin: whence, description: String(description || '') }, // cap-hygiene: NO swissnum in the detail shown to the LLM/DOM
          commit: async () => {
            // A full ENDO DAEMON INVITATION (endo://…?type=invitation, dialed over iroh+captp0) is a
            // daemon-to-daemon protocol, not a swissnum fetch: REDEEM it via the peer-daemon sidecar
            // (E(host).accept over iroh). On success we hold a live PEER (a mailbox relationship), filed as
            // transport 'endo-peer' and called with send/inbox via callObject.
            if (/type=invitation/i.test(String(link))) {
              let acc;
              try { acc = await peerBridge.acceptInvitation(link, nm); } catch (e) { throw new Error(`couldn't redeem "${nm}": ${e.message}`); }
              if (!acc || !acc.ok) throw new Error(`couldn't redeem "${nm}" — the peer-daemon did not confirm the accept`);
              acceptedObjects = acceptedObjects.filter(x => x.name !== nm).concat([{ name: nm, origin: '', transport: 'endo-peer', address: String(link), swissnum: parsed.swissnum, description: String(description || ''), methods: ['send', 'inbox', 'describe'], peer: true, addedAt: new Date().toISOString(), by: agent }]);
              saveAcceptedObjects();
              return { ok: true, name: nm, transport: 'endo-peer', peer: true, methods: ['send', 'inbox', 'describe'] };
            }
            // Discover methods at accept-time. iroh refs dial over the iroh
            // transport; HTTP refs use /rpc. (An iroh ref has origin:'' — it
            // must NOT fall through to rpcCall, which would hit our OWN /rpc
            // with a foreign swissnum.) Best-effort: methods stay [] if the
            // peer is unreachable; the ref is still accepted and callable.
            let d;
            if (parsed.transport === 'iroh') {
              const r = await dialIrohObject({ address: parsed.address, swissnum: parsed.swissnum, method: 'describe', args: [] });
              d = r.ok ? r.value : { error: r.error };
            } else {
              d = await rpcCall(parsed.origin, parsed.swissnum, 'describe', []);
            }
            const methods = (d && Array.isArray(d.methods)) ? d.methods : (Array.isArray(d) ? d : []);
            acceptedObjects = acceptedObjects.filter(x => x.name !== nm).concat([{ name: nm, origin: parsed.origin, transport: parsed.transport || '', address: parsed.address || '', swissnum: parsed.swissnum, description: String(description || ''), methods, addedAt: new Date().toISOString(), by: agent }]);
            saveAcceptedObjects();
            return { ok: true, name: nm, methods, transport: parsed.transport || 'http' };
          } });
      } },
    listObjects: { reversible: false, args: {}, description: 'List the objects in your inventory (accepted Endo invites): name, where each is from, what it does, its methods, and its transport (http and iroh are both callable; iroh = dial-by-pubkey over QUIC). Each is SELF-DOCUMENTING — if an object\'s methods are unknown/empty, callObject(name, "describe") or "help" reveals them. Call one with callObject.',
      run: async () => ({ ok: true, objects: acceptedObjects.map(o => { const tp = isPeerCallable(o) ? 'endo-peer' : (isHttpCallable(o) ? 'http' : (o.transport || (o.origin && o.origin !== 'null' ? 'http' : 'iroh'))); return { name: o.name, origin: isPeerCallable(o) ? '(live peer, via iroh)' : (o.origin && o.origin !== 'null' ? o.origin : '(this instance)'), transport: tp, callable: isHttpCallable(o) || isIrohCallable(o) || isPeerCallable(o), description: o.description || '', methods: o.methods || [] }; }) }) },
    callObject: { reversible: false, args: { name: 'string — an object name from listObjects', method: 'string — the method to call (use "describe" to discover its methods)', args: 'array — arguments' },
      description: 'Call a method on an object in your inventory (an accepted Endo capability). Endo objects are SELF-DOCUMENTING: if you do not recognise an object or do not know its methods, FIRST call method "describe" (or "help") to discover what it offers, THEN call those methods — never abandon an inventory object as "unusable" without introspecting it this way. The held swissnum is used host-side; never shown. HTTP-origin objects are called over /rpc; endo-iroh (dial-by-pubkey) references are dialed over the iroh QUIC transport under the same CapTP/ocap layer. A redeemed PEER (transport "endo-peer", from an accepted invitation) is a MAILBOX, not a synchronous API — use method "send" (message them) and "inbox" (read their replies), not arbitrary method names.',
      run: async ({ name, method, args } = {}) => {
        const o = acceptedObjects.find(x => x.name === String(name || ''));
        if (!o) return { ok: false, error: `no object named "${name}" — see listObjects` };
        // Route to the object's transport. The method string lives in routeObjectCall (the ONE router) — NOT
        // in agent code: a known object is normally a LIVE in-scope presence the agent calls as Name.method().
        return routeObjectCall(o, method, args);
      } },
    // ⚠️ self-improvement: implement on an isolated worktree → independently verify → (flag-gated) auto-merge.
    improveSystem: { reversible: false, args: { goal: 'string — the concrete system improvement to implement', successCommand: 'string — OPTIONAL: the command that must pass to prove it (defaults to the full voice-agent test suite)' },
      description: 'Autonomously IMPLEMENT a system improvement: a confined executor builds it on a FRESH git worktree + ships a test; the harness INDEPENDENTLY re-verifies, and (only if SELF_IMPROVE_AUTOMERGE is enabled) merges to the live branch with a post-merge re-verify + auto-revert on failure. One at a time. With auto-merge off it stops at a verified, ready-to-review branch (the safe default).',
      run: async ({ goal, successCommand }, agent) => {
        const g = String(goal || '').trim();
        if (!g) return harden({ ok: false, error: 'a goal is required' });
        if (selfImproveInFlight) return harden({ ok: false, busy: true, error: 'a self-improvement is already in flight — one at a time' });
        selfImproveInFlight = true;
        try {
          return harden(await selfImprover.improve({ goal: g, successCommand: successCommand ? String(successCommand) : undefined, employExecutor: ({ goal: gg }) => runWorktreeExecutor({ goal: gg, successCommand }), autoMerge: SELF_IMPROVE_AUTOMERGE, now: new Date().toISOString() }));
        } finally { selfImproveInFlight = false; }
      } },
    // ── FAPO-style backlog: research PROPOSES precise targets; the loop DRAINS the top one + records the outcome. ──
    proposeImprovement: { reversible: false, args: { goal: 'string — what to improve + how the suite proves it. A PRECISE file-scoped change implements most reliably (e.g. "In packages/chat/ocapn-noise/codemode.mjs, add a single-retry around recoverable tool errors + a *.test.mjs asserting one retry"), but a LARGER ARCHITECTURAL change spanning several files is also fine now — the SUITE is the gate (it lands only if it stays green + re-verifies post-merge), so describe the change clearly + how to verify it.', successCommand: 'string — OPTIONAL: the command that proves it (defaults to the full suite)', rationale: 'string — OPTIONAL: the research that motivated it' },
      description: 'Add an improvement TARGET to the backlog (the dataset the self-improvement loop drains). A target may be a precise file-scoped change OR a larger architectural change — both are allowed; the suite (independent verify + post-merge re-verify) is what gates it landing, not file-scoping. Describe the change + how it is verified. Use this to turn research into implementable targets.',
      run: async ({ goal, successCommand, rationale }, agent) => harden(addBacklog({ goal, successCommand, rationale, by: agent || '' })) },
    listImprovements: { reversible: false, args: { status: 'string — OPTIONAL filter: open | staged | merged' },
      description: 'List the improvement backlog — the concrete targets + their recorded outcomes (so you see what is queued, staged for review, merged, or repeatedly failing).',
      run: async ({ status }) => harden({ ok: true, items: listBacklog({ status: status || undefined }) }) },
    runNextImprovement: { reversible: false, args: {},
      description: 'DRAIN the backlog: take the top OPEN target, implement it on an isolated worktree, INDEPENDENTLY verify, (flag-gated) auto-merge, and RECORD the outcome (attribution: merged / staged-for-review / failed+why). One at a time. This is how the loop makes real progress — precise targets, deterministically implemented + verified.',
      run: async (a, agent) => {
        if (selfImproveInFlight) return harden({ ok: false, busy: true, error: 'a self-improvement is already in flight — one at a time' });
        const item = nextOpen();
        if (!item) return harden({ ok: true, empty: true, note: 'the improvement backlog has no open target — proposeImprovement some first (precise file-scoped or larger architectural; the suite gates them)' });
        selfImproveInFlight = true;
        try {
          const r = await selfImprover.improve({ goal: item.goal, successCommand: item.successCommand || undefined, employExecutor: ({ goal: gg }) => runWorktreeExecutor({ goal: gg, successCommand: item.successCommand }), autoMerge: SELF_IMPROVE_AUTOMERGE, now: new Date().toISOString() });
          const status = r.merged ? 'merged' : r.readyToReview ? 'staged' : 'failed';
          recordOutcome(item.id, { status, branch: r.branch, reason: r.reason });
          return harden({ ok: true, target: item.goal, targetId: item.id, outcome: status, ...r });
        } finally { selfImproveInFlight = false; }
      } },
    listChangelog: { reversible: false, args: { limit: 'number — OPTIONAL: how many recent entries (default 50)' },
      description: 'The CHANGELOG of self-applied (auto-merged) improvements: each {id, goal, mergeCommit, mergedAt, rolledBack}. This is what was actually shipped to the live branch by the loop.',
      run: async ({ limit } = {}) => harden({ ok: true, merges: selfImprover.listMerges({ limit: Number(limit) || 50 }) }) },
    revertChange: { reversible: false, args: { id: 'string — the changelog entry id to undo (from listChangelog)' },
      description: 'REVERT a self-applied change by its changelog id — git revert -m 1 of the recorded merge commit (history-preserving). Use if a shipped change is causing problems.',
      run: async ({ id } = {}) => harden(await selfImprover.rollback({ id: String(id || ''), now: new Date().toISOString() })) },
    readNote: { reversible: false, args: { path: 'string — vault-relative path' }, description: 'Read one personal note by path.',
      run: async ({ path: rel }, agent, ctx = {}) => ({ ok: true, content: String(await (ctx.notes || aff.notes).read(String(rel || ''))).slice(0, 6000) }) },
    // NON-DESTRUCTIVE note CREATION — fires directly, no proposal. Creating a new note (or appending to
    // one) only ever ADDS; it cannot overwrite or delete, so it needs no confirmation. This is the
    // self-hosted private notepad: the entry agent can record SENSITIVE things that never leave the
    // network. To CHANGE/replace existing note content (destructive), the agent must use proposeNoteEdit.
    addNote: { reversible: false,
      args: {
        title: 'string — the note title (becomes its filename + H1)',
        content: 'string — the note body, in markdown',
        folder: 'string — OPTIONAL vault-relative folder to file it under (default "inbox")',
        append: 'boolean — OPTIONAL: if a note with this title already exists in the folder, ADD to the end of it instead of creating a new uniquely-named one (still never overwrites)',
      },
      description: 'CREATE a new note in your private vault — NON-DESTRUCTIVE (only ever ADDS a note, or appends to one; never overwrites or deletes), so it fires IMMEDIATELY with no confirmation. This is your self-hosted private notepad: jot things straight down, including SENSITIVE notes that must never leave the network. It auto-picks a unique filename so an existing note is never clobbered (or pass append:true to add to a same-titled one). To CHANGE or replace an existing note\'s content, use proposeNoteEdit instead (that one is gated by your confirmation).',
      run: async ({ title, content, folder, append }, agent) => {
        const t = String(title || '').trim() || 'note';
        const slug = nickId(t) || 'note';
        const dir = String(folder || 'inbox').replace(/^\/+|\/+$/g, '') || 'inbox';
        const stamp = new Date().toISOString();
        if (append) {
          const rel = `${dir}/${slug}.md`;
          const r = await aff.editNote.appendTo(rel, `\n---\n*added ${stamp}*\n\n${String(content ?? '')}\n`);
          return harden({ ok: true, created: false, appended: true, path: r.savedTo, note: `Appended to ${rel} (stays on the network).` });
        }
        const body = `---\ncreated: ${stamp}\nsource: agent-c\ntags: [agent-note]\n---\n\n# ${t}\n\n${String(content ?? '')}\n`;
        let rel = `${dir}/${slug}.md`;
        for (let i = 2; i <= 99; i += 1) {
          try { const r = await aff.editNote.createNew(rel, body); return harden({ ok: true, created: true, path: r.savedTo, note: `Saved a new private note at ${rel} — it stays on the network.` }); }
          catch (e) { if (String(e && e.code) !== 'EEXIST') throw e; rel = `${dir}/${slug}-${i}.md`; }
        }
        return harden({ ok: false, error: 'could not find a free filename for this note' });
      } },
    consult: { reversible: false, args: { question: 'string' }, description: 'Ask your library (Gutenberg) + Wikipedia a question.',
      run: async ({ question }) => aff.reference.ask(String(question || '')) },
    fetchUrl: { reversible: false, args: { url: 'string' }, description: 'Fetch + summarize one public web page (SSRF-guarded).',
      run: async ({ url }) => aff.web.get(String(url || '')) },
    webSearch: { reversible: false, args: { query: 'string — what to search the web for' }, description: 'Search the WEB with Brave and get the top results (title, url, snippet). Use this to FIND pages; then fetchUrl or browseWeb to read one.',
      run: async ({ query }) => aff.web.search(String(query || '')) },
    research: { reversible: false, args: { query: 'string — the research question', depth: 'string — "quick" | "normal" | "deep" (more sub-agents)' },
      description: 'Employ a RESEARCH TEAM: a lead decomposes your question into sub-questions, runs PARALLEL sub-agents (each searches the web + reads + distills, with its own isolated context), then synthesizes a CITED report. Use for non-trivial, breadth-first questions — not single facts.',
      run: async ({ query, depth }, agent, ctx) => {
        let n = 0; const emit = ev => { if (ctx && ctx.emit) { try { ctx.emit(ev); } catch { /* best effort */ } } };
        // Map research's semantic events → live `rnode` upserts the pendant renders in real time:
        // the PLAN (sub-questions = what it's researching), each search/fetch (with its query/url),
        // and the slow "distilling"/"synthesizing" gemma phases — so nothing is dead air. Tool names +
        // queries/URLs only; never the cap or page contents (cap-hygiene).
        return runResearch({ query: String(query || ''), depth: String(depth || 'normal'),
          tools: { webSearch: x => aff.web.search(x), fetchUrl: x => aff.web.get(x), consult: x => aff.reference.ask(x) },
          onStep: ev => {
            if (!ev) return;
            if (ev.kind === 'plan') { for (const s of (ev.subs || [])) emit({ t: 'rnode', parent: 'research', key: `s${s.i}`, kind: 'subq', label: `❓ ${String(s.q).slice(0, 30)}`, detail: s.q, state: 'pending' }); }
            else if (ev.kind === 'tool') emit({ t: 'rnode', parent: `s${ev.sub}`, key: `s${ev.sub}t${(n += 1)}`, kind: 'tool', label: ev.name, detail: ev.detail || '', state: 'done' });
            else if (ev.kind === 'distill' && ev.state === 'start') emit({ t: 'rnode', parent: `s${ev.sub}`, key: `s${ev.sub}d`, kind: 'phase', label: 'distilling…', state: 'pending' });
            else if (ev.kind === 'subdone') { emit({ t: 'rnode', key: `s${ev.sub}d`, state: 'done', label: 'distilled' }); emit({ t: 'rnode', key: `s${ev.sub}`, state: ev.ok === false ? 'fail' : 'done', info: ev.summary || '' }); }
            else if (ev.kind === 'synth') { if (ev.state === 'start') emit({ t: 'rnode', parent: 'research', key: 'synth', kind: 'phase', label: 'synthesizing…', state: 'pending' }); else emit({ t: 'rnode', key: 'synth', state: 'done', label: 'report', info: ev.detail || '' }); }
          } });
      } },
    browseWeb: { reversible: false, args: { url: 'string' }, description: 'Open a URL in a REAL headless browser (renders JavaScript) and return the page title + readable text. Use when fetchUrl is not enough (JS-heavy / interactive pages). SSRF-guarded.',
      run: async ({ url }) => aff.browser.visit(String(url || '')) },
    screenshotWeb: { reversible: false, args: { url: 'string' }, description: 'Open a URL in a real headless browser and capture a screenshot; returns a saved web-key path (/uploads/…).',
      run: async ({ url }) => aff.browser.shot(String(url || '')) },
    transcribeYoutube: { reversible: false, args: { url: 'string — a YouTube video URL' }, description: 'Fetch the transcript/captions of a YouTube video (read-only). Returns the title + dedup\'d text.',
      run: async ({ url }) => aff.youtube.transcribe({ url }) },
    generateImage: { reversible: true, args: { prompt: 'string — what to draw' }, description: 'Generate an image on the GPU. Returns the saved path.',
      run: async ({ prompt }) => aff.images.generate({ prompt }), abort: () => aff.images.abort() },
    pushFeed: { reversible: false, args: { title: 'string', body: 'string' }, description: 'Post a routine item to your daily feed.',
      run: async ({ title, body }, agent, ctx) => aff.feed.post({ title, body, links: chatLink(ctx) ? [chatLink(ctx)] : [] }) },
    notify: { reversible: false, args: { title: 'string', body: 'string' }, description: 'Raise a NOTIFICATION / action item to dan\'s "Needs your attention" inbox (the 🔔 bell). Use for things he should see or act on.',
      run: async ({ title, body }, agent, ctx) => aff.feed.notify({ title, body, agent, link: chatLink(ctx) }) },
    listNotifications: { reversible: false, args: {}, description: 'Read recent items in dan\'s notification inbox (what is in the 🔔 feed).',
      run: async () => ({ ok: true, items: await aff.feed.recent() }) },
    askOperator: { reversible: false, args: { title: 'string — short title of the decision you need', questions: 'array — [{q, type, options?, key?}]; type ∈ text|choice|multiselect|bool|number|approve-reject|secret; options[] for choice/multiselect; for a `secret` question add key:"<name>" (e.g. "brave-api-key") to store it in the named key vault tools read from' },
      description: 'Raise a STRUCTURED, TYPED question for dan to answer INLINE (radios / checkboxes / yes-no / number / approve-reject) rather than a vague "would you like me to…". Use when you genuinely need a decision to proceed. He answers right in the app and you continue. PREFER this over ending your reply with an open question.',
      run: async ({ title, questions }, agent, ctx) => { const ask = addAsk({ title: String(title || ''), questions: Array.isArray(questions) ? questions : [], origin: { kind: 'chat', chatId: (ctx && ctx.chatId) || '' }, requestedBy: agent || 'field-agent' }); return harden({ asked: true, askId: ask.id, title: ask.title, questions: ask.questions.length, note: 'Raised a typed question for dan; he answers it inline and you continue.' }); } },
    // The INVITEE back-channel: a confined guest's one write — reach the owner (dan). Lands in his
    // 🔔 inbox + a phone push, deep-linked to the chat. This is the "send me messages" starter tool.
    messageOwner: { reversible: false, args: { subject: 'string — short subject', message: 'string — your message to the owner' },
      description: 'Send a message to the OWNER of this agent (dan). It lands in his inbox and pushes to his phone. This is your channel to reach him — ask for help, request more access, or report something. Use it freely.',
      run: async ({ subject, message }, agent, ctx) => {
        const subj = String(subject || '').slice(0, 120); const msg = String(message || '').slice(0, 2000);
        await aff.feed.notify({ title: `✉️ Message from ${agent}${subj ? `: ${subj}` : ''}`, body: msg, agent, link: chatLink(ctx) });
        try { await aff.phone.push({ title: `✉️ ${agent}`, message: `${subj ? `${subj} — ` : ''}${msg}`.slice(0, 150), click: chatLink(ctx) || '' }); } catch { /* push best-effort */ }
        return harden({ ok: true, sent: true, note: 'Delivered to the owner\'s inbox + phone.' });
      } },
    // Connected API services (Phase 3 Lane A): call a tool the owner wired up. The API key is
    // injected SERVER-SIDE from the vault — you never see it. read-only connectors are GET-only.
    listConnectors: { reversible: false, args: {}, description: 'List the connected API services (tools) you can call — each connector\'s id, name, base URL, and whether its key is set.',
      run: async () => ({ ok: true, connectors: connectorsObj.list() }) },
    callConnector: { reversible: false, args: { id: 'string — a connector id from listConnectors', path: 'string — the API path (e.g. /v1/search)', method: 'string — GET/POST/… (read-only connectors are always GET)', query: 'object — optional query params', body: 'object — optional JSON body for non-GET' },
      description: 'Call a connected API service by id. The owner configured the base URL + auth; the API key is injected server-side (you never handle it). Paid services bill your credit (market rate + commission). Returns {status, data}. Use listConnectors to discover what is available.',
      run: async ({ id, path: p, method, query, body }, agent, ctx = {}) => {
        // Paid-services billing (Phase 4): a connector with a costUusd bills the caller's purse
        // market-rate + commission (default 1%) — our margin. Charge BEFORE the call; refuse if broke.
        const c = connectorsObj.get(String(id || ''));
        const billed = connectorsObj.billedFor(c);
        if (billed > 0 && typeof ctx.charge === 'function') {
          if (ctx.charge(billed) === false) return { ok: false, error: 'insufficient credit for this paid service — add credit to use it', billedUusd: billed };
        }
        return connectorsObj.call(String(id || ''), { path: p, method, query, body });
      } },
    // Admitted library tools (custom-tools.mjs): agent-built, human-reviewed code tools. Each runs in a
    // fresh SES Compartment with no ambient authority (pure functions of `args`).
    listCustomTools: { reversible: false, args: {}, description: 'List the admitted library tools (agent-built, owner-reviewed) you can call — name + what each does.',
      run: async () => ({ ok: true, tools: customToolsObj.list() }) },
    callCustomTool: { reversible: false, args: { name: 'string — a tool name/id from listCustomTools', method: 'string — which method to call (stateful tools expose methods; omit for a single-function tool)', args: 'object — inputs for the method' },
      description: 'Call an admitted library tool. Stateful tools expose methods — pass `method`; a single-function tool takes just `args`. The tool keeps its state across calls. Returns {value}.',
      run: async ({ name: tname, method, args } = {}) => customToolsObj.call(String(tname || ''), { method, args: (args && typeof args === 'object') ? args : {} }) },
    pushPhone: { reversible: false, args: { title: 'string', message: 'string' }, description: 'Push a notification to your phone.',
      run: async ({ title, message }, agent, ctx) => { const link = chatLink(ctx); return aff.phone.push({ title, message: link ? `${String(message || '')}\n\n→ open chat: ${link}` : message, click: link }); } },
    scheduleWakeup: { reversible: false, args: { delayMs: 'number — ms from now (omit if using atIso)', atIso: 'string — ISO time (optional, instead of delayMs)', title: 'string', message: 'string' },
      description: 'Schedule a one-off wake-up/reminder that pushes to your phone at a future time. Survives restarts.',
      run: async ({ delayMs, atIso, title, message }, agent, ctx = {}) => (ctx.timers || aff.timers).schedule({ delayMs, atIso, title, message }) },
    repeatEvery: { reversible: false, args: { everyMs: 'number — interval in ms', title: 'string', message: 'string' },
      description: 'Schedule a REPEATING reminder (interval) that pushes to your phone. Survives restarts.',
      run: async ({ everyMs, title, message }, agent, ctx = {}) => (ctx.timers || aff.timers).repeat({ everyMs, title, message }) },
    cancelTimer: { reversible: false, args: { id: 'string — timer id from listTimers' }, description: 'Cancel a scheduled timer/interval by id.',
      run: async ({ id }, agent, ctx = {}) => (ctx.timers || aff.timers).cancel(id) },
    listTimers: { reversible: false, args: {}, description: 'List your scheduled timers and intervals.',
      run: async (a, agent, ctx = {}) => ({ ok: true, timers: await (ctx.timers || aff.timers).list() }) },
    // ── SCHEDULED TASKS: recurring autonomous runs that DO the work (vs timers, which just ping a human).
    //    The created task runs `prompt` with a tool ring ⊆ the creator's own powers (no escalation), so a
    //    request like "check X daily and notify me" becomes a self-running job, not a "remind me" reminder. ──
    scheduleTask: {
      reversible: false,
      args: { name: 'string — short label', prompt: 'string — the INSTRUCTIONS the run executes, written as a task to DO (e.g. "Visit <url>; if the sale is live, notify me once"). NOT "remind dan to…".', tools: 'array — power names the run may use, a subset of YOUR powers (e.g. ["browser","feed","phone"])', cadence: 'object — {kind:"daily",at:"HH:MM"} | {kind:"weekly",day:0-6,at:"HH:MM"} | {kind:"interval",everyMs:N}' },
      description: 'Create a recurring SCHEDULED TASK: a future autonomous run that DOES the work itself on a cadence and can notify you of the result — NOT a reminder that pings dan to do it. Use for "check X daily", "every morning do Y". (For a one-off nudge a human must act on, use a reminder via scheduleWakeup instead.)',
      run: async ({ name, prompt, tools, cadence }, agent, ctx = {}) => {
        if (!String(prompt || '').trim()) return { ok: false, error: 'a scheduled task needs a prompt — the instructions it will run' };
        if (!cadence || !cadence.kind) return { ok: false, error: 'a scheduled task needs a cadence, e.g. {kind:"daily",at:"08:00"}' };
        const own = new Set(ctx.ownPowers || []);
        const want = Array.isArray(tools) ? tools : [];
        const granted = want.filter(t => own.has(t) && !META_POWERS.has(t)); // never escalate past the creator
        const proj = (ctx.chatId && projectForChat(ctx.chatId)) || listProjects().find(p => p.name === 'Scheduled tasks') || createProject('Scheduled tasks');
        const sa = addScheduledAgent(proj.id, { name: String(name || prompt).slice(0, 60), prompt: String(prompt), tools: granted, schedule: cadence, model: 'default', enabled: true });
        const nextAt = computeNextAt(cadence, Date.now());
        updateScheduledAgent(proj.id, sa.id, { nextAt });
        const dropped = want.filter(t => !granted.includes(t));
        return { ok: true, taskId: sa.id, project: proj.name, tools: granted, nextAt, note: `Scheduled — it will run itself ${cadence.kind === 'interval' ? `every ${Math.round((cadence.everyMs || 0) / 60000)}m` : `${cadence.kind} at ${cadence.at || ''}`}.${dropped.length ? ` (Dropped tools you don't hold: ${dropped.join(', ')}.)` : ''}` };
      } },
    listScheduledTasks: { reversible: false, args: {}, description: 'List all scheduled tasks (recurring autonomous runs): their prompt, tools, cadence, last run + next run time. Use to find a taskId to edit/cancel.',
      run: async () => ({ ok: true, tasks: listProjects().flatMap(p => (p.scheduledAgents || []).map(a => ({ taskId: a.id, project: p.name, name: a.name, prompt: a.prompt, tools: a.tools, schedule: a.schedule, enabled: a.enabled, lastRun: a.lastRun, nextAt: a.nextAt }))) }) },
    editScheduledTask: { reversible: false, args: { taskId: 'string — from listScheduledTasks', prompt: 'string (optional) — new instructions', cadence: 'object (optional) — new schedule', tools: 'array (optional) — new tool ring (subset of your powers)', enabled: 'boolean (optional) — false to pause, true to resume' },
      description: 'Edit an existing scheduled task: change its prompt, cadence, tool ring, or pause/resume it (enabled). Find ids via listScheduledTasks.',
      run: async ({ taskId, prompt, cadence, tools, enabled }, agent, ctx = {}) => {
        const proj = listProjects().find(p => (p.scheduledAgents || []).some(a => a.id === taskId));
        if (!proj) return { ok: false, error: 'no such scheduled task — list them with listScheduledTasks' };
        const patch = {};
        if (prompt != null) patch.prompt = String(prompt);
        if (enabled != null) patch.enabled = !!enabled;
        if (Array.isArray(tools)) { const own = new Set(ctx.ownPowers || []); patch.tools = tools.filter(t => own.has(t) && !META_POWERS.has(t)); }
        if (cadence && cadence.kind) { patch.schedule = cadence; patch.nextAt = computeNextAt(cadence, Date.now()); }
        const a = updateScheduledAgent(proj.id, taskId, patch);
        return { ok: true, taskId, updated: Object.keys(patch), enabled: a.enabled, nextAt: a.nextAt };
      } },
    cancelScheduledTask: { reversible: false, args: { taskId: 'string — from listScheduledTasks' }, description: 'Delete a scheduled task by id.',
      run: async ({ taskId }) => { const proj = listProjects().find(p => (p.scheduledAgents || []).some(a => a.id === taskId)); if (!proj) return { ok: false, error: 'no such scheduled task' }; removeScheduledAgent(proj.id, taskId); return { ok: true, taskId, deleted: true }; } },
    // ── DESTRUCTIVE: these only PROPOSE. The user confirms before anything happens. ──
    proposeNoteEdit: { reversible: false, args: { path: 'string — vault-relative .md path', content: 'string — new content (or text to append)', mode: 'string — "overwrite" (default) or "append"' },
      description: 'PROPOSE an edit to a note. Does NOT write — the user must confirm the diff first. Say you have proposed it.',
      run: async ({ path: rel, content, mode = 'overwrite' }, agent) => {
        const relS = String(rel || '');
        const old = await aff.editNote.read(relS);
        const next = String(mode) === 'append' ? `${old}${old && !old.endsWith('\n') ? '\n' : ''}${String(content || '')}` : String(content || '');
        return propose({ type: 'note-edit', power: 'editNote', agent, title: `Edit ${relS}`, summary: `${mode} · ${relS}`,
          detail: { path: relS, mode: String(mode), oldContent: old.slice(0, 12000), newContent: next.slice(0, 12000) },
          commit: () => aff.editNote.write(relS, next) });
      } },
    proposeEmail: { reversible: false, args: { to: 'string', subject: 'string', body: 'string' },
      description: 'PROPOSE an email. Does NOT send — the user reviews + confirms; only on confirm is it sent via the SMTP relay (or drafted if no relay creds are set).',
      run: async ({ to, subject, body }, agent) => propose({ type: 'email', power: 'email', agent, title: `Email: ${String(subject || '(no subject)')}`, summary: `To ${String(to || '')}`,
        detail: { to: String(to || ''), subject: String(subject || ''), body: String(body || '').slice(0, 6000) },
        commit: () => aff.email.send({ to, subject, body }) }) },
    proposeSubAgent: { reversible: false, args: { name: 'string', task: 'string', powers: 'array — capabilities it would need' },
      description: 'PROPOSE spawning a sub-agent with system access. Does NOT spawn — on confirm it is queued to the dashboard for a second approval.',
      run: async ({ name, task, powers }, agent) => propose({ type: 'subagent', power: 'subagent', agent, title: `Spawn sub-agent: ${String(name || 'sub')}`, summary: String(task || ''),
        detail: { name: String(name || 'sub'), task: String(task || ''), powers: Array.isArray(powers) ? powers : [] },
        commit: () => aff.subagent.queue({ name, task, powers }) }) },
    vmExec: { reversible: false, args: { cmd: 'string — shell command to run in the agent-code dev VM', cwd: 'string — optional working directory' },
      description: 'Run a shell command in the agent-code dev VM (runs immediately; coarse authority). Returns stdout/stderr/exit code.',
      run: async ({ cmd, cwd }) => aff.vm.exec(String(cmd || ''), { cwd }) },
    hostExec: { reversible: false, args: { cmd: 'string — shell command, runs on the archua host as the operator', cwd: 'string — optional working directory (default ~)' },
      description: 'Run a shell command on THIS host (archua) as the operator — the dev/dogfood harness. Immediate (the grant is the authorization). COARSE host-root authority: clone repos, run builds/tests/evals, edit files — equivalent to the operator\'s own shell. Returns stdout/stderr/exit code. You have this only if you hold the `host` power.',
      run: async ({ cmd, cwd }, agent, ctx = {}) => aff.host.exec(String(cmd || ''), { cwd, jail: (ctx && ctx.wtDir) || undefined }) },
    proposeSystemPrompt: { reversible: false, args: { prompt: 'string — the new instructions block (replaces your current editable system-prompt section)' },
      description: 'PROPOSE a change to your OWN system prompt (the editable instructions block). Does NOT apply — the user confirms the diff first. A built-in agent (e.g. the Specialist Builder) edits ITS OWN prompt; Agent C edits the global one.',
      run: async ({ prompt }, agent) => {
        const builtin = isBuiltinId(agent);
        const cur = builtin ? builtinPersona(agent) : (persona || '');
        return propose({ type: 'system-prompt', power: 'selfPrompt', agent, title: builtin ? `Modify ${agent} prompt` : 'Modify system prompt', summary: builtin ? `edit the ${agent} agent's instructions` : "edit the agent's own instructions",
          detail: { path: builtin ? `(${agent} prompt)` : '(system prompt)', mode: 'overwrite', oldContent: (cur || '(none yet)').slice(0, 12000), newContent: String(prompt || '').slice(0, 12000) },
          commit: () => (builtin ? setBuiltinPersona(agent, prompt) : writePersona(prompt)) });
      } },
    proposeGiveKazputer: { reversible: false, args: { name: 'string — whose Kazputer (a display name)', email: 'string — the recipient email; if the user named a person, contactsSearch them FIRST and ask which one if ambiguous' },
      description: 'PROPOSE giving someone a new Kazputer: on confirm it creates a fresh kid-phone instance and EMAILS them the invite link. Does NOT fire — the user confirms first.',
      run: async ({ name, email }, agent) => propose({ type: 'give-kazputer', power: 'kazputer', agent, title: `Give ${String(name || 'someone')} a Kazputer`, summary: `email → ${String(email || '(no email)')}`,
        detail: { name: String(name || ''), email: String(email || '') },
        commit: async () => {
          const p = await aff.kazputer.provision({ name: String(name || 'Kazputer'), owner: String(name || '') });
          if (!p.ok) return p;
          const body = `Here is ${String(name || 'your')} Kazputer — a kid-phone of apps. Open this link on the device to use it:\n\n${p.kidUrl}\n\nGrown-up controls (keep this one private):\n${p.adminUrl}\n\n— sent by the field agent`;
          const m = await aff.email.send({ to: String(email || ''), subject: `${String(name || 'Your')} Kazputer is ready`, body });
          return harden({ ok: m.ok !== false, kazputer: { id: p.id, name: p.name }, emailed: !!m.sent, note: m.note || m.error || 'sent' });
        } }) },
    kazputerStatus: { reversible: false, args: {}, description: 'Read the status of your own Kazputer (kid-phone): apps, coin balance, free-play, on/off.',
      run: async () => (kazAdmin ? { ok: true, status: await kazAdmin.describe() } : { ok: false, error: 'your Kazputer admin is unavailable' }) },
    proposeKazputerSetting: { reversible: false, args: { setting: 'string — "freePlay" or "usable" (turned on)', value: 'boolean' },
      description: 'PROPOSE a setting change on your own Kazputer (free play on/off, or turn the phone on/off). Does NOT fire — you confirm first.',
      run: async ({ setting, value }, agent) => propose({ type: 'kazputer-setting', power: 'kazputer', agent, title: `Kazputer: ${String(setting)} = ${value}`, summary: 'change a Kazputer setting',
        detail: { setting: String(setting || ''), value: !!value }, commit: () => (kazAdmin ? kazAdmin.set(String(setting), !!value) : { ok: false, error: 'no kazputer admin' }) }) },
    proposeKazputerCoins: { reversible: false, args: { coins: 'number — positive to award, negative to dock' },
      description: 'PROPOSE awarding or docking coins on your own Kazputer. Does NOT fire — you confirm first.',
      run: async ({ coins }, agent) => propose({ type: 'kazputer-coins', power: 'kazputer', agent, title: `Kazputer: ${Number(coins) >= 0 ? '+' : ''}${Number(coins) || 0} coins`, summary: 'adjust the coin balance',
        detail: { coins: Number(coins) || 0 }, commit: () => (kazAdmin ? kazAdmin.award(Number(coins) || 0) : { ok: false, error: 'no kazputer admin' }) }) },
    // ── DIETICIAN pipeline — CUT OVER from SSH-driving the persona to the dietician-app's
    //    in-process JS port (packages/chat/dietician-app) over the host's instance store; the Places +
    //    Anthropic keys are read from the secret registry server-side, never reaching the agent). Scan
    //    (auto-geocodes new cities) / evaluate / build mutate only the local instance DB (contained);
    //    PUBLISHING a guide is OUTWARD → dietRefreshSite only PROPOSES (you confirm; on confirm it writes the
    //    JS-generated HTML to the deploy lane so the live public guides keep updating). ──
    dietScanArea: { reversible: false, args: { city: 'string — a city slug or name, e.g. "berlin", "oakland", "san-francisco". A city not yet configured is auto-geocoded so you can scan ANYWHERE.' },
      description: "Scan an area's restaurants against the household diet (a Google Places sweep, in-process; dedupes against what's known; a NEW city is auto-geocoded first). Returns the new candidate restaurants. Then dietEvaluateArea to judge them.",
      run: async ({ city }) => dietScan(city) },
    dietEvaluateArea: { reversible: false, args: { city: 'string — the city you just scanned', limit: 'number — how many to evaluate this call (default 3, max 8)' },
      description: "Evaluate scanned restaurants against Alexa's diet: finds each menu, judges VIABLE / BORDERLINE / SKIP / UNKNOWN with a strong model, and records the verdict. Idempotent (skips ones already done). Run dietScanArea(city) first. A batch can take a minute or two.",
      run: async ({ city, limit }) => dietEval({ city, limit, tools: { webSearch: x => aff.web.search(x), fetchUrl: x => aff.web.get(x), browse: x => aff.browser.visit(x) } }) },
    dietBuildMap: { reversible: false, args: {}, description: 'Rebuild the safe-eats Google-Maps map (KML) from the evaluated restaurant database on the dietician persona.',
      run: async () => dietBuild() },
    dietStatus: { reversible: false, args: {}, description: "Read the dietician pipeline status — how many places are evaluated (by verdict) and each published guide's pending (un-published) changes.",
      run: async () => dietStat() },
    dietRefreshSite: { reversible: false, args: { site: `string — one of [${DIET_SITES.join(', ')}]`, message: 'string — optional short commit note' },
      description: "PROPOSE refreshing + publishing a food-guide site (regenerates it from the latest evaluations; on confirm it git-pushes → archua-deploy serves the update). Does NOT publish until you confirm. Use after evaluating new places.",
      run: async ({ site, message }, agent) => {
        const r = await dietRegen(site);
        if (!r.ok) return r;
        if (!r.willPublish) return harden({ ok: true, site, note: 'Guide regenerated — no changes to publish (already current).' });
        return propose({ type: 'diet-site-update', power: 'dietician', agent, title: `Publish ${site} update`, summary: `${r.changedFiles.length} file(s) changed`,
          detail: { site, changedFiles: r.changedFiles, regenOutput: r.regenOutput }, commit: () => dietPublish(site, message || `refresh ${site}`) });
      } },
    // ── APP SELF-STATE — the agent's access to ALL stateful aspects of the app it lives in:
    //    every conversation (chats / voice memos / ingested voice notes) — list, read, RETITLE —
    //    plus an overview. The app accessor is bound to this cap by the SERVER (the swissnum never
    //    reaches the agent — cap-hygiene). Retitling is the user's own metadata (reversible), so it
    //    fires directly; reads are free. (Motivating capture: "title the voice-note chats descriptively.")
    listChats: { reversible: false, args: {}, description: 'List EVERY conversation in this app — regular chats, voice memos, and ingested voice notes — with id, title, kind, turn count, and a preview. Use this to review your history (e.g. to give them better titles).',
      run: async (a, agent, ctx) => (ctx && ctx.app ? { ok: true, conversations: await ctx.app.listChats() } : { ok: false, error: 'app state is only available in a live chat turn' }) },
    readChat: { reversible: false, args: { id: 'string — a conversation id from listChats' }, description: 'Read one conversation in full (its transcript / messages), so you can understand what it is about — e.g. before retitling it.',
      run: async ({ id }, agent, ctx) => (ctx && ctx.app ? await ctx.app.readChat(String(id || '')) : { ok: false, error: 'app state unavailable here' }) },
    retitleChat: { reversible: false, args: { id: 'string — a conversation id from listChats', title: 'string — the new, descriptive title' }, description: 'Rename a conversation (chat, voice memo, or voice note) to a more descriptive title. Applies immediately and shows on the next refresh. Reversible — just retitle again. Use after readChat to choose a good title.',
      run: async ({ id, title }, agent, ctx) => (ctx && ctx.app ? await ctx.app.retitle(String(id || ''), String(title || '')) : { ok: false, error: 'app state unavailable here' }) },
    appState: { reversible: false, args: {}, description: 'An overview of ALL your app state: counts of chats / voice memos / voice notes, open questions (asks), feed items, pending proposals, specialists, and whether a custom persona is set.',
      run: async (a, agent, ctx) => {
        const s = (ctx && ctx.app) ? await ctx.app.summary() : {};
        const pendingProposals = [...proposals.values()].filter(p => p.status === 'pending').length;
        return { ok: true, ...s, pendingProposals, specialists: specialists.length, personaSet: !!(persona && persona.trim()) };
      } },
  });

  // Build the toolbox ({name → {run, abort?}}) for a given power set, scoped to
  // a node (so createInvite/delegateTask can mint sub-caps the node may grant).
  const toolboxAndManifestFor = (powers, node, ctx = {}) => {
    const toolbox = {}; const manifest = [];
    // Route the timer/notes verbs through THIS cap's binding (a granular share is scoped to one
    // timer / a vault subtree); the root/full cap has no binding → falls back to the full
    // aff.timers / aff.notes (unchanged).
    ctx = { ...ctx, timers: (node.timersBinding && node.timersBinding()) || aff.timers, notes: (node.notesBinding && node.notesBinding()) || aff.notes, wtDir: (node.cwdBinding && node.cwdBinding()) || null, ownPowers: [...(node.powers || powers)] };
    // node-bound propose: tags every proposal with WHO created it, so "don't ask
    // again" rules are scoped to this agent (root, share, or specialist).
    const np = spec => propose({ ...spec, agent: node.id });
    for (const power of powers) {
      for (const v of POWERS[power].verbs) {
        const b = baseVerb[v];
        if (!b) continue; // delegate/createInvite handled specially
        // inject the acting agent's id (run's 2nd arg) + the run-context (3rd arg:
        // chatId, so notify/push verbs can deep-link the originating chat)
        toolbox[v] = harden(b.abort ? { run: a => b.run(a, node.id, ctx), abort: b.abort } : { run: a => b.run(a, node.id, ctx) });
        manifest.push({ name: v, description: b.description, args: b.args, reversible: !!b.abort });
      }
    }
    // NATIVE-ENDO inventory: bind each CALLABLE accepted object as a LIVE in-scope object, so the agent calls
    // its methods directly (`await Kumavis.send('hi')`) instead of callObject(name,'method',args) string
    // dispatch. codemode's methods[] branch renders it as `const Kumavis = <live object>; await Kumavis.send()`.
    // Gated on the `objects` power; never shadows a verb name. (callObject remains as the introspection escape
    // hatch for not-yet-described objects.)
    if (powers.has('objects')) {
      for (const o of acceptedObjects) {
        if (!(isHttpCallable(o) || isIrohCallable(o) || isPeerCallable(o))) continue;
        const nm = sanitizeIdent(o.name);
        if (!nm || toolbox[nm]) continue; // never shadow a verb / collide
        toolbox[nm] = presenceFor(o);
        manifest.push({ name: nm, description: `${o.description || 'an accepted Endo object'}${(o.transport === 'endo-peer' || o.peer) ? ' — a live PEER you message' : ' — a live object you hold'}`, methods: methodsOfObject(o) });
      }
    }
    // CARRY LOCATED DEVICES across turns: bind the HA entities the agent engaged with earlier in THIS chat as
    // live in-scope objects (e.g. Roborock_Q5.state() / Roborock_Q5.act({action:'start'})), so a follow-up acts
    // on the SAME device by name without re-running haFind. (Reads free; act() still PROPOSES — operator confirms.)
    if (powers.has('homeassistant')) {
      const loc = locatedByChat.get((ctx && ctx.chatId) || '');
      if (loc) for (const e of [...loc.values()].slice(-8)) {
        const nm = sanitizeIdent(e.name);
        if (!nm || toolbox[nm]) continue; // never shadow a verb / inventory object
        toolbox[nm] = haEntityPresence(node, e);
        manifest.push({ name: nm, description: `${e.name} — a Home Assistant device you located earlier in this chat${e.state ? ` (last seen: ${e.state})` : ''}`, methods: [
          { name: 'state', args: {}, description: 'read its live state (free)' },
          { name: 'act', args: { action: 'string — e.g. start, turn_on, lock, set_temperature', data: 'object — optional service data' }, description: 'PROPOSE an action on it (the operator confirms)' }] });
      }
    }
    if (powers.has('delegate')) {
      // delegateTask: hand the prompt to Opus with an ATTENUATED sub-bundle
      // (intersection of this node's powers and the requested powers). The
      // sub-agent's tools ARE that bundle — confinement at the delegation edge.
      // A per-run AbortController makes the delegation barge-in-cancellable:
      // runTool calls abort() when the user talks over an in-flight delegation.
      let activeDelegate = null;
      toolbox.delegateTask = harden({
        run: async ({ prompt, powers: want = [], nickname }) => {
          const granted = new Set([...(Array.isArray(want) ? want : [])].filter(p => node.powers.has(p) && !META_POWERS.has(p)));
          // The sub-agent is its OWN node: its own (fresh) home folder + c-list,
          // inheriting this node's HA binding for any HA authority granted. So a
          // delegate asked to "build a site" gets its own home to write + publish
          // from, and only the powers passed.
          const dkey = crypto.randomBytes(3).toString('hex');
          const petName = String(nickname || '').trim() || genPetName(); // agent-proposed readable name, else a friendly pet name (NEVER an ugly id)
          const nick = nickId(petName); // url-safe id/label stem
          const subNode = makeAgentNode({ powers: [...granted], labelOf: nick, haBinding: node.haBinding, agBinding: node.agBinding, id: `${nick}-${dkey}` });
          const sub = subNode.toolbox(ctx); // inherit the originating chat so delegated pushes deep-link too
          const ac = new AbortController(); activeDelegate = ac;
          // Carry the ORIGINATING request into the delegate so its own record shows what led to it.
          const lead = ctx.userText ? `The user's original request that led to this delegation (context — keep it in mind):\n"${String(ctx.userText).slice(0, 1200)}"\n\nYour task:\n` : '';
          try {
            const r = await runOpusDelegate({ prompt: lead + String(prompt || ''), toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: [...granted], signal: ac.signal });
            // If the delegate BUILT + proposed any tools, RETURN them to the caller as data (not
            // injected into scope). They're pending dan's review; the caller learns one was made.
            const proposedTools = customToolsObj.pendingBy(subNode.id);
            return harden({ ...r, agentName: petName, ...(proposedTools.length ? { proposedTools } : {}) });
          } finally { if (activeDelegate === ac) activeDelegate = null; }
        },
        abort: () => { try { activeDelegate?.abort(); } catch {} },
      });
      manifest.push({ name: 'delegateTask', reversible: true,
        args: { prompt: 'string — the task', powers: `array — subset of [${[...node.powers].filter(p => !META_POWERS.has(p)).join(', ')}] to grant the sub-agent`, nickname: 'string — OPTIONAL but encouraged: a short readable name for this delegate (e.g. "flights-builder"), shown in the trace + as the proposer of anything it builds. You may delegate MANY in one turn.' },
        description: 'Break a task off to a larger (Opus) agent, granting it ONLY the listed powers. Use this ONLY when (a) the scope is too big for one agent (genuinely multi-stage / parallelizable / needs a bigger brain), OR (b) it involves potentially destructive actions best done by a confined least-authority sub-agent. Do NOT delegate a read, lookup, or single-tool action you can just do yourself. Give it a nickname; you may call this MULTIPLE times in one response for several delegates.' });
    }
    if (powers.has('roles')) {
      // EMPLOY A ROLE — the doc's "roles are configurations, not classes." Each role
      // (agent-roles.mjs) is a tuple { tool ring, system prompt, context policy, model
      // tier, I/O contract }. The entry agent is the ORCHESTRATOR; employ() runs a role
      // in an ISOLATED context and returns ONLY its distilled result (narrow return
      // contract). Read/analysis roles → a FRESH confined sub-node (parallelizable).
      // Code/WRITE roles (isolation:'worktree') → a fresh sub-node whose host shell is
      // confined to its OWN git worktree, so parallel writers edit disjoint checkouts and
      // can't race (this RETIRES the old single-threaded-writes rule). Like delegateTask,
      // an in-flight employ is barge-in-cancellable.
      let activeEmploy = null;
      toolbox.employ = harden({
        run: async ({ role, task, powers: want, model, nickname } = {}) => {
          const spec = getRole(role);
          if (!spec) return { ok: false, error: `unknown role "${String(role || '')}". Employable roles: ${roleList().map(r => r.role).join(', ')}. Call listRoles for details.` };
          const taskS = String(task || '').trim();
          if (!taskS) return { ok: false, role: spec.role, error: 'a task is required (what should the role do?)' };
          // ALL roles (incl. dev/coder/debugger) run IN-FRAMEWORK as confined CodeMode sub-agents whose
          // every step shows in the trace graph — no black-box Blacksmith. A dev role's authority is its
          // ring (host/home/…) ∩ YOUR powers. (Legacy `via:'dev'` routing to an external session retired;
          // an external dev session is reachable only via the explicit routeToDev tool, if un-benched.)
          // EVERY role → a fresh sub-node confined to the INTERSECTION of the
          // role's ring and THIS node's powers (least privilege; can't exceed your
          // authority — lexical, not prompt). meta-powers stripped (one level deep).
          const ring = new Set([...spec.powers].filter(p => node.powers.has(p) && !META_POWERS.has(p)));
          if (Array.isArray(want) && want.length) { const keep = new Set(want); for (const p of [...ring]) if (!keep.has(p)) ring.delete(p); } // optional caller-narrowing only SUBTRACTS
          const rkey = crypto.randomBytes(3).toString('hex');
          const petName = String(nickname || '').trim() || genPetName(); // agent-proposed name, else a friendly pet name
          const nick = nickId(petName);
          const wtId = `${nick}-${rkey}`;
          // A WRITE-CAPABLE role (isolation:'worktree') that holds the host shell gets its OWN git
          // worktree for the duration of the run, so PARALLEL writers edit disjoint checkouts and
          // cannot race. (home/fileWrite are already per-node isolated; hostExec was the one shared
          // write seam.) The worktree confines hostExec's default dir + guards its cwd arg — it is
          // race-isolation + a recoverable diff, NOT a kernel sandbox (host stays ambient root).
          let wt = null;
          let wtInfo = null;
          if (spec.isolation === 'worktree' && ring.has('host')) {
            try { wt = await worktrees.create(wtId); }
            catch (e) { return harden({ ok: false, role: spec.role, error: `worktree setup failed: ${String((e && e.message) || e)}` }); }
          }
          const subNode = makeAgentNode({ powers: [...ring], labelOf: nick, haBinding: node.haBinding, agBinding: node.agBinding, cwdBinding: wt ? () => wt.dir : null, id: `${nick}-${rkey}` });
          const sub = subNode.toolbox(ctx); // inherit the originating chat (deep-links)
          const proposalIds = []; const autoFired = []; const toolsUsed = [];
          const ac = new AbortController(); activeEmploy = ac;
          let out = null;
          try {
            const wantOpus = model === 'opus' || model === 'strong';
            const wantLocal = model === 'gemma' || model === 'default' || model === 'local';
            // STRONG tier (or explicit "opus") → the bigger brain; falls back to gemma if no API key.
            if (wantOpus || (spec.tier === 'strong' && !wantLocal)) {
              const prompt = `${spec.prompt}\n\nTASK:\n${taskS}\n\nReturn: ${spec.output}`;
              const r = await runOpusDelegate({ prompt, toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: [...ring], signal: ac.signal });
              if (!r.error) out = harden({ ok: true, role: spec.role, via: 'opus', tier: spec.tier, answer: r.answer, toolsUsed: r.toolsUsed || [], granted: [...ring] });
              // else fall through to local gemma (e.g. no ANTHROPIC_API_KEY)
            }
            if (!out) {
              const r = await AGENT_RUNNER({ toolbox: sub.toolbox, manifest: sub.manifest, userText: `TASK:\n${taskS}\n\nReturn: ${spec.output}`, persona: spec.prompt, signal: ac.signal,
                // a REAL caller model id wins; the "gemma"/"local"/"default" sentinels (wantLocal) and
                // the tier fall through to localModelFor (the role's local model, 'default' today).
                model: (model && !wantOpus && !wantLocal) ? String(model) : localModelFor(spec.tier),
                onStep: s => { if (s.kind !== 'tool' || !s.result) return; if (s.result.proposed && s.result.id) proposalIds.push(s.result.id); if (s.result.autoConfirmed) autoFired.push({ title: s.result.title, type: s.result.type, ok: s.result.fired !== false }); if (s.name) toolsUsed.push({ name: s.name }); } });
              out = harden({ ok: true, role: spec.role, via: 'local', tier: spec.tier, answer: r.answer, toolsUsed: toolsUsed.length ? toolsUsed : (r.toolsUsed || []), proposalIds, autoFired, granted: [...ring] });
            }
          } finally {
            if (activeEmploy === ac) activeEmploy = null;
            // Tear down the worktree LAST (cancel-safe): commit any diff to its branch, then remove.
            if (wt) { try { wtInfo = await worktrees.teardown(wtId, { commitMessage: `${spec.role}: ${taskS.slice(0, 72)}` }); } catch (e) { wtInfo = harden({ removed: false, error: String((e && e.message) || e), branch: wt.branch }); } }
          }
          const result = out || harden({ ok: false, role: spec.role, error: 'the role produced no result' });
          return harden({ ...result, agentName: petName, ...(wtInfo ? { worktree: wtInfo } : {}) });
        },
        abort: () => { try { activeEmploy?.abort(); } catch { /* best effort */ } },
      });
      toolbox.listRoles = harden({ run: async () => ({ ok: true,
        note: 'You are the ORCHESTRATOR. employ() a role to do focused work in an ISOLATED context — only its distilled result returns to you, keeping your own context clean. COMPOSE roles for non-trivial work (e.g. planner → retriever×N → synthesizer → critic; or executor → reviewer → debugger for code). EVERY role — analysis AND dev/coder/debugger — runs IN-FRAMEWORK as a confined CodeMode sub-agent whose steps appear in the trace graph (no black-box dev session). Dev roles get a host/home dev ring; each role is granted only the intersection of its ring and YOUR powers. `tier`: "strong" → the bigger brain (Opus); "mid"/"cheap" → a local model. Pass model:"opus"/"gemma" to force.',
        roles: roleList() }) });
      manifest.push(
        { name: 'employ', reversible: true,
          args: { role: `string — one of [${roleList().map(r => r.role).join(', ')}]`, task: 'string — the focused task/question for that role', powers: 'array — OPTIONAL: narrow the role\'s tool ring to this subset', model: 'string — OPTIONAL: "opus" to force the bigger brain, "gemma" to force local, or a local model id', nickname: 'string — OPTIONAL but encouraged: a short readable name for this employed sub-agent (shown in the trace). You may employ MANY in one turn.' },
          description: 'Employ a SPECIALIZED ROLE sub-agent (a pre-configured tool ring + role system prompt + model tier) to do focused work in its OWN isolated context; only its distilled result returns. You are the orchestrator — COMPOSE roles for big tasks instead of doing everything in one context. Code/write roles route to the single-threaded Blacksmith. See listRoles for the menu.' },
        { name: 'listRoles', reversible: false, args: {}, description: 'List the specialized roles you can employ() — each with its tool ring, model tier, and what it returns.' },
      );
    }
    if (powers.has('homeassistant')) {
      // The agent navigates by handle (web-keys) — but a handle is only usable if
      // it is in this cap's C-LIST (capability list): the set of nodes reachable
      // by drilling DOWN from what it holds. haTree seeds the c-list with the held
      // node and adds each child it returns; haState/haAct refuse a handle not in
      // the c-list. So a holder can NEVER name a node outside its binding — closing
      // the confused-deputy hole that global handle-resolution would open. READ is
      // free; ACT only proposes (confirmable).
      // haFind: search everything you hold by name/id in ONE call (vs drilling).
      toolbox.haFind = harden({ run: async ({ query } = {}) => {
        const start = node.haStart();
        if (!start?.search) return { ok: false, error: 'search not available on your binding — use haTree to navigate' };
        const matches = start.search(String(query || ''));
        matches.forEach(m => node.haCList.add(m.handle)); // learn handles so haState/haAct work
        if (matches.length <= 8) matches.forEach(m => recordLocated(ctx.chatId, { handle: m.handle, name: m.name || m.label || m.friendly_name })); // a TARGETED find → carry these devices across turns
        return { ok: true, count: matches.length, matches };
      } });
      toolbox.haTree = harden({ run: async ({ handle } = {}) => {
        const start = handle ? node.haReach(handle) : node.haStart();
        if (!start) return { ok: false, error: handle ? 'handle not in your reach (navigate to it first)' : 'HomeAssistant not available' };
        return { ok: true, node: node.haLearn(await start.describe()) };
      } });
      toolbox.haState = harden({ run: async ({ handle }) => {
        const n = node.haReach(handle); if (!n?.state) return { ok: false, error: 'handle not in your reach, or not an entity' };
        const st = await n.state();
        recordLocated(ctx.chatId, { handle, name: st.name || st.friendly_name || (st.attributes && st.attributes.friendly_name), state: st.state }); // carry this device across turns
        return { ok: true, ...st };
      } });
      toolbox.haAct = harden({ run: async ({ handle, action, data }) => {
        const n = node.haReach(handle); if (!n) return { ok: false, error: 'handle not in your reach' };
        if (!n.act) return { ok: false, error: 'this node is read-only or not an actuable entity' };
        recordLocated(ctx.chatId, { handle }); // the device the agent is acting on — carry it across turns
        try { return n.act(String(action || ''), data || {}); } catch (e) { return { ok: false, error: e.message }; }
      } });
      manifest.push(
        { name: 'haFind', reversible: false, args: { query: 'string — name, entity_id, ROOM/area, or DOMAIN/type fragment, e.g. "kitchen", "light", "lock", "hrv", "temperature"' }, description: 'Search ALL Home Assistant entities you can reach in ONE call — by name, id, room/area, or device type. Returns handles you can immediately haState (read) or haAct (propose). Searching + reading HA are ALWAYS FREE — never a confirmation prompt. FASTEST way to reach devices; pass a broad term (a whole room or a type like "sensor"/"light") to pull MANY at once for a read-everything pass. Usually ONE good query is enough — READ the matches you get back (haState) before searching again.' },
        { name: 'haTree', reversible: false, args: { handle: 'string — a node handle to drill into; OMIT to see your top level (rooms)' }, description: 'Browse the Home Assistant hierarchy when you have no name: omit `handle` for the top level (rooms), pass a handle to drill rooms → device types → entities. Each call reveals child handles you can then haState/haAct. Reading is always free. To jump straight to a known device, prefer haFind.' },
        { name: 'haState', reversible: false, args: { handle: 'string — an entity handle from haFind or haTree' }, description: "Read one entity's live state + attributes by its handle. Always free, never prompts — read as many entities as you need (that's how you read 'everything': haFind/haTree to enumerate handles, then haState each)." },
        { name: 'haAct', reversible: false, args: { handle: 'string — an entity handle from haFind/haTree', action: 'string — e.g. turn_on, turn_off, toggle, lock, unlock, set_temperature', data: 'object — optional service data' }, description: 'PROPOSE a device action by handle. This is the ONLY HA verb that is gated: it does NOT act — it queues a proposal the operator ALWAYS confirms (physical-world actions never auto-fire). Reads never go through here.' },
      );
    }
    if (powers.has('agents')) {
      // The agent personas on this machine, navigated by web-key handle from the
      // held roster (same c-list confinement as HA). agentsList/agentStatus are
      // free READ; agentExec is the coarse terminal (immediate, like the vm power).
      toolbox.agentsList = harden({ run: async () => {
        const s = node.agStart(); if (!s) return { ok: false, error: 'agent roster not available' };
        return { ok: true, node: node.agLearn(await s.describe()) };
      } });
      toolbox.agentStatus = harden({ run: async ({ handle }) => {
        const n = node.agReach(handle); if (!n?.status) return { ok: false, error: 'handle not in your reach' };
        return { ok: true, ...(await n.status()) };
      } });
      toolbox.agentExec = harden({ run: async ({ handle, cmd, cwd }) => {
        const n = node.agReach(handle); if (!n) return { ok: false, error: 'handle not in your reach' };
        if (!n.exec) return { ok: false, error: 'this persona is read-only' };
        return n.exec(String(cmd || ''), { cwd });
      } });
      // A FULL-VM machine (e.g. tinix) also carries a LOCAL config CHECKOUT — repoStatus reads its HEAD; repoExec
      // runs a command IN it (edit config + ./deploy-models.sh, which ssh-pushes to the box). The remote shell
      // over the box stays on agentExec. (See the /tinix skill.)
      toolbox.machineRepoStatus = harden({ run: async ({ handle }) => {
        const n = node.agReach(handle); if (!n) return { ok: false, error: 'handle not in your reach' };
        if (!n.repoStatus) return { ok: false, error: 'this machine has no config checkout (no git repo configured)' };
        return n.repoStatus();
      } });
      toolbox.machineRepoExec = harden({ run: async ({ handle, cmd, cwd }) => {
        const n = node.agReach(handle); if (!n) return { ok: false, error: 'handle not in your reach' };
        if (!n.repoExec) return { ok: false, error: 'this machine has no writable config checkout (read-only, or no git repo configured)' };
        return n.repoExec(String(cmd || ''), { cwd });
      } });
      // Route a task to a registered CODE SESSION (the Blacksmith dev agent) — for
      // building tools/connectors you can't do yourself. Enqueues to the dev-queue the
      // field-agent-chats skill polls; the session reviews + reports back.
      toolbox.routeToDev = harden({ run: async ({ handle, task } = {}) => {
        let n = handle ? node.agReach(handle) : null;
        // First-call convenience: if the handle is absent or not a routable code
        // session (the agent guessed, or hasn't agentsList'd for the opaque web-key
        // handle yet), resolve a registered dev session directly — by id/name, by
        // "blacksmith", or the sole one. A holder of the `agents` power IS authorized
        // to route, so this doesn't widen authority; it just removes the dead first call.
        if ((!n || !n.route) && agentRoster?.devNode) {
          const d = agentRoster.devNode(handle);
          if (d && d.route) n = d;
        }
        if (!n) return { ok: false, error: 'no code session registered yet — ask dan to connect a Blacksmith (field-agent-chats skill); agentsList shows what is available' };
        if (!n.route) return { ok: false, error: 'that handle is a persona, not a code session — use agentExec for personas; routeToDev targets registered code sessions (kind: dev-session)' };
        return n.route(String(task || ''), { chatId: (ctx && ctx.chatId) || '' });
      } });
      manifest.push(
        { name: 'agentsList', reversible: false, args: {}, description: 'List the agents on this machine — personas (name, ip, role) you can status/exec on, AND registered code sessions (kind: dev-session) you can routeToDev. Returns handles.' },
        { name: 'agentStatus', reversible: false, args: { handle: 'string — a handle from agentsList' }, description: "Read an agent's status (a persona's up?/uptime/PID1, or a code session's registration)." },
        { name: 'agentExec', reversible: false, args: { handle: 'string — persona/machine handle', cmd: 'string — shell command', cwd: 'string — optional working dir' }, description: 'Run a shell command in an agent persona OR over a machine (e.g. ssh to the tinix box — nvidia-smi/docker ps). Immediate; coarse authority.' },
        { name: 'machineRepoStatus', reversible: false, args: { handle: 'string — a machine handle from agentsList' }, description: "Read a full-VM machine's LOCAL config checkout — the repo whose HEAD is its source-of-truth config (e.g. ~/tinix): current HEAD/branch/subject + dirty files." },
        { name: 'machineRepoExec', reversible: false, args: { handle: 'string — a machine handle', cmd: 'string — shell command run IN the checkout (git ops, generate-compose.py, ./deploy-models.sh)', cwd: 'string — optional working dir (defaults to the repo root)' }, description: 'Run a command in a full-VM machine\'s LOCAL config checkout — e.g. edit ~/tinix/deployments.yaml then ./deploy-models.sh, which ssh-pushes the new compose to the box. Coarse authority over that repo. (See the /tinix skill.)' },
        { name: 'routeToDev', reversible: false, args: { handle: 'string — OPTIONAL: a code-session handle from agentsList, a name/id, or "blacksmith"; omit to use the default dev session', task: 'string — the tool-build / code task to hand off' }, description: 'Route a task to a registered code session (the Blacksmith) IF one is connected, when you need a tool/connector built or code run you cannot do yourself. It may be unavailable (none registered) — if routeToDev says so, do not keep retrying; instead consider proposeTool (build the tool yourself) or tell dan what is needed.' },
      );
    }
    if (powers.has('home')) {
      // The agent's virtual home folder (its own sandbox dir). Read/write/list +
      // publishSite → a static-served URL. Confined to its folder; no ambient fs.
      // a chat filed under a project binds its home to the PROJECT's shared folder (ctx.homeSubkey);
      // otherwise the node's own home. So a project's chats + scheduled agents share one folder.
      const home = () => (ctx.homeSubkey ? makeHome(ctx.homeSubkey) : node.homeBinding?.());
      toolbox.fileList = harden({ run: async ({ path: rel } = {}) => { const h = home(); return h ? h.list(rel || '') : { ok: false, error: 'no home folder' }; } });
      toolbox.fileRead = harden({ run: async ({ path: rel }) => { const h = home(); return h ? h.read(rel) : { ok: false, error: 'no home folder' }; } });
      toolbox.fileWrite = harden({ run: async ({ path: rel, content }) => { const h = home(); if (!h?.write) return { ok: false, error: 'read-only home' }; return h.write(rel, content); } });
      // publishSite → also emit a `site-preview` WIDGET so the published site renders as a nice inline
      // link-preview card (live thumbnail + Open) in the chat, not just a bare URL. (rv.widget is forwarded
      // to r.ui by the server; the /sites token is a web-key that's meant to be opened, so rendering it is fine.)
      toolbox.publishSite = harden({ run: async ({ path: rel, name }) => { const h = home(); if (!h?.publishSite) return { ok: false, error: 'read-only home' }; try { const r = await h.publishSite(rel || '', name); return (r && r.url) ? { ok: true, ...r, widget: { type: 'site-preview', url: r.url, name: r.name } } : r; } catch (e) { return { ok: false, error: e.message }; } } });
      // createDownloadLinkFor(path) → a working DOWNLOAD link for a file in your home, to hand the user in a
      // reply. Returns { url:'/dl/<token>' } — embed it as a markdown link. The url is relative to this app's
      // origin (so it works whether the user is on the tailnet or the public address).
      toolbox.createDownloadLinkFor = harden({ run: async ({ path: rel, name }) => { const h = home(); if (!h?.downloadLink) return { ok: false, error: 'no home folder' }; try { return await h.downloadLink(String(rel || ''), name); } catch (e) { return { ok: false, error: e.message }; } } });
      manifest.push(
        { name: 'fileList', reversible: false, args: { path: 'string — sub-path inside your home (optional)' }, description: 'List files in your home folder.' },
        { name: 'fileRead', reversible: false, args: { path: 'string — file path inside your home' }, description: 'Read a file from your home folder.' },
        { name: 'fileWrite', reversible: false, args: { path: 'string — file path inside your home', content: 'string' }, description: 'Write a file in your home folder (creates dirs). Self-scoped — no confirmation needed.' },
        { name: 'publishSite', reversible: false, args: { path: 'string — a folder in your home holding index.html', name: 'string — a label' }, description: 'Publish a folder from your home as a static site; returns its URL.' },
        { name: 'createDownloadLinkFor', reversible: false, args: { path: 'string — a file in your home folder', name: 'string — optional download filename' }, description: 'Mint a working DOWNLOAD link for a file in your home folder, so you can give the user a clickable download in your reply. Returns { url } — put it in your reply as a markdown link.' },
      );
    }
    if (powers.has('contacts')) {
      // Address book: READ is free (search/get); add/edit only PROPOSE — the user
      // confirms before any CardDAV write. (contactsObj is built at boot.)
      const noBook = { ok: false, error: 'address book unavailable (no NextCloud creds / not built yet)' };
      // Route ALL contacts verbs through this cap's BINDING (not the module book) so a granular
      // single-contact share is genuinely confined — it sees/edits only the contact it was minted for.
      // For the root/full cap the binding IS the whole book, so behavior is unchanged.
      const book = () => (node.contactsBinding && node.contactsBinding()) || null;
      const roBook = { ok: false, error: 'this is a read-only contacts share — it can view but not propose edits' };
      toolbox.contactsSearch = harden({ run: async ({ query } = {}) => { const b = book(); return b ? { ok: true, matches: await b.search(String(query || '')) } : noBook; } });
      toolbox.contactsGet = harden({ run: async ({ handle } = {}) => { const b = book(); return b ? { ok: true, contact: await b.get(String(handle || '')) } : noBook; } });
      toolbox.proposeAddContact = harden({ run: async ({ name, email, phone, org, note } = {}) => {
        const b = book(); if (!b) return noBook; if (b.readOnly || !b.add) return roBook;
        return np({ type: 'contact-add', power: 'contacts', title: `Add contact: ${String(name || '(no name)')}`, summary: [email, phone].filter(Boolean).join(' · '),
          detail: { name: String(name || ''), email: String(email || ''), phone: String(phone || ''), org: String(org || ''), note: String(note || '') },
          commit: () => b.add({ fn: String(name || ''), emails: email ? [String(email)] : [], tels: phone ? [String(phone)] : [], org: String(org || ''), note: String(note || '') }) }); } });
      toolbox.proposeEditContact = harden({ run: async ({ handle, name, email, phone, org, note } = {}) => {
        const b = book(); if (!b) return noBook; if (b.readOnly || !b.update) return roBook;
        return np({ type: 'contact-edit', power: 'contacts', title: `Edit contact: ${String(name || handle || '')}`, summary: [email, phone].filter(Boolean).join(' · '),
          detail: { handle: String(handle || ''), name: String(name || ''), email: String(email || ''), phone: String(phone || ''), org: String(org || ''), note: String(note || '') },
          commit: () => b.update(String(handle || ''), { fn: name, emails: email ? [String(email)] : undefined, tels: phone ? [String(phone)] : undefined, org, note }) }); } });
      manifest.push(
        { name: 'contactsSearch', reversible: false, args: { query: 'string — a name/email/phone fragment (empty lists the first 25)' }, description: 'Search your address book (read-only). Returns handles + names/emails/phones.' },
        { name: 'contactsGet', reversible: false, args: { handle: 'string — a contact handle from contactsSearch' }, description: "Read one contact's full details by handle." },
        { name: 'proposeAddContact', reversible: false, args: { name: 'string', email: 'string', phone: 'string', org: 'string', note: 'string' }, description: 'PROPOSE adding a contact to your address book. Does NOT write — the user confirms first.' },
        { name: 'proposeEditContact', reversible: false, args: { handle: 'string — from contactsSearch', name: 'string', email: 'string', phone: 'string', org: 'string', note: 'string' }, description: 'PROPOSE editing a contact (by handle). Only the fields you set change. Does NOT write — the user confirms first.' },
      );
    }
    if (powers.has('specialists')) {
      // Spawn + consult persistent specialist sub-agents. Spawning grants authority,
      // so it PROPOSES (you confirm the grant). A specialist runs with its OWN confined
      // bundle + instructions + id; its actions still surface for confirmation unless
      // you granted it autonomy ("don't ask again", scoped to that specialist).
      toolbox.listSpecialists = harden({ run: async () => ({ ok: true, specialists: [...builtinList(), ...specialists.map(s => ({ id: s.id, name: s.name, domain: s.domain, powers: s.powers, autonomy: listAutoRules(s.id).map(r => r.kind), spawnedFrom: s.spawnedFrom || null }))] }) });
      toolbox.proposeSpawnSpecialist = harden({ run: async ({ name, domain, powers: want = [], instructions } = {}) => {
        const granted = [...new Set((Array.isArray(want) ? want : []).filter(p => node.powers.has(p) && !META_POWERS.has(p)))];
        return np({ type: 'spawn-specialist', power: 'specialists', title: `Spawn specialist: ${String(name || 'specialist')}`, summary: `${String(domain || '')}${granted.length ? ' · ' + granted.join(', ') : ' · (no powers)'}`,
          detail: { name: String(name || ''), domain: String(domain || ''), powers: granted, instructions: String(instructions || '').slice(0, 4000) },
          commit: () => spawnSpecialist({ name, domain, powers: granted, instructions, spawnedFromChatId: ctx.chatId }) });
      } });
      toolbox.askSpecialist = harden(makeAskSpecialist(ctx.userText));
      manifest.push(
        { name: 'listSpecialists', reversible: false, args: {}, description: 'List your specialist sub-agents (name, domain, powers, and what each may do autonomously).' },
        { name: 'proposeSpawnSpecialist', reversible: false, args: { name: 'string', domain: 'string — the kind of requests it handles', powers: 'array — a subset of YOUR powers to grant it (meta-powers excluded)', instructions: 'string — its standing instructions / persona' }, description: 'PROPOSE spawning a persistent specialist sub-agent into your inventory. Does NOT spawn — you confirm the grant first.' },
        { name: 'askSpecialist', reversible: true, args: { name: 'string — a specialist from listSpecialists', request: 'string — what to ask it to do' }, description: 'Hand a request to one of your specialists; it acts within its own confined powers + context. Its destructive actions still surface for your confirmation unless you granted it autonomy.' },
      );
    }
    // createInvite is always available (a node may re-share powers it holds).
    toolbox.createInvite = harden({
      run: async ({ power, name }) => {
        const r = node.share(String(power || ''), String(name || ''));
        // CAP HYGIENE: never return the link to the LLM (it must not speak/render
        // a cap). The URL lives only in the Shares panel. Return a confirmation.
        return { ok: true, power: r.power, name: r.label, note: 'Invite link created — open the Shares panel (top-right) to copy it or show a QR. The link itself is intentionally NOT shown here.' };
      },
    });
    manifest.push({ name: 'createInvite', reversible: false,
      args: { power: `string — one of [${[...node.powers].join(', ')}]`, name: 'string — a label so you can recognize it to revoke later' },
      description: 'Create a NAMED, revocable invite link granting ONE of your powers to someone else. The link is shown only in the Shares panel, never spoken.' });
    // shareTool — share an admitted library component, as a factory or an attenuated/metered/priced
    // instance. Mirrors createInvite's cap-hygiene: never speak the link (Shares panel only); revoke
    // by the render-safe id, never the secret token.
    toolbox.shareTool = harden({ run: async ({ tool, mode, access, methods, ratePerMin, quota, ttlMs, priceUsd } = {}) => {
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}" — only admitted library tools can be shared (see listCustomTools)` };
      const rec = toolSharesObj.create({ toolId: t.id, toolName: t.name, mode, access, methods, ratePerMin, quota, ttlMs, priceUsd, sharer: node.id, now: new Date().toISOString() });
      const per = rec.mode === 'factory' ? 'import' : 'use';
      const price = rec.priceUsd ? `${(rec.priceUsd / 1e6).toFixed(rec.priceUsd >= 10000 ? 2 : 6)} USD per ${per}` : 'free';
      const what = rec.mode === 'git' ? `git object (${rec.access})` : rec.mode;
      return { ok: true, id: rec.id, mode: rec.mode, access: rec.access, toolName: t.name, price, attenuation: rec.attenuation, note: `Shared "${t.name}" as a ${what} (${price}). Open the Shares panel to copy the link or show a QR — the link itself is intentionally NOT shown here. Revoke later with revokeToolShare({ id: "${rec.id}" }).` };
    } });
    manifest.push({ name: 'shareTool', reversible: false,
      args: { tool: 'string — an admitted tool name/id (listCustomTools)', mode: "string — 'factory' (recipient hosts their OWN instance), 'instance' (an attenuated, metered reference to YOUR hosted instance), or 'git' (the component AS its EndoGit object — read its source/versions, or collaborate)", access: "string — for mode 'git': 'read' (read-only: history/files/read) or 'write' (collaborator: also commit new versions the owner reviews)", methods: 'string[] — (instance) restrict to these method names; omit for all', ratePerMin: 'number — (instance/git) max calls per minute; omit = unlimited', quota: 'number — max total uses; omit = unlimited', ttlMs: 'number — expiry in ms from now; omit = no expiry', priceUsd: 'number — µUSD charged to the consumer per use/op; omit/0 = free' },
      description: 'SHARE an admitted library component with others — as a FACTORY (they host their own instance), an attenuated, metered, REVOCABLE INSTANCE (a reference to your hosted one), or a GIT object (the component AS its EndoGit cap: access "read" lets them read its source + version history; "write" makes them a collaborator who commits new versions you review). Chargeable in the usual allowance currency; payment enforced on the consumer the standard way. The link appears only in the Shares panel, never spoken. Revoke with revokeToolShare.' });
    toolbox.revokeToolShare = harden({ run: async ({ id } = {}) => { const r = toolSharesObj.revoke(String(id || '')); return r.ok ? { ok: true, note: 'Share revoked — future uses/imports are refused immediately.' } : { ok: false, error: r.error || 'unknown share' }; } });
    manifest.push({ name: 'revokeToolShare', reversible: false, args: { id: 'string — the render-safe share id (from shareTool or the Shares panel)' },
      description: 'Revoke a component share you created (the caretaker). Identify it by its render-safe id — never the secret token.' });
    // componentHistory / revertComponent — a component's SOURCE is a git-as-Endo object (version history,
    // fork, non-destructive revert). History is read-only; reverting the live shared component is the owner's call.
    toolbox.componentHistory = harden({ run: async ({ tool } = {}) => {
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}"` };
      const versions = (await componentGitObj.history(t.id)).map(v => ({ version: String(v.version).slice(0, 12), summary: v.summary, at: v.at }));
      return { ok: true, tool: t.name, versions };
    } });
    manifest.push({ name: 'componentHistory', reversible: false, args: { tool: 'string — an admitted tool name/id' },
      description: 'List the VERSION history of a component (its source is a git-as-Endo object): each {version, summary, at}, newest first. Read-only.' });
    toolbox.revertComponent = harden({ run: async ({ tool, version } = {}) => {
      if (!node.isRoot) return { ok: false, error: 'reverting a shared component is the owner\'s call — ask the owner (requestAccess) or propose it.' };
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}"` };
      const snap = await componentGitObj.readAt(t.id, String(version || '')); if (!snap) return { ok: false, error: 'unknown version (see componentHistory)' };
      const rv = await componentGitObj.revert(t.id, String(version || '')); customToolsObj.setSource(t.id, snap.files);
      return { ok: true, tool: t.name, version: String(rv.version).slice(0, 12), note: 'Reverted to the chosen version (a new version; history preserved). The live tool now runs the reverted source.' };
    } });
    manifest.push({ name: 'revertComponent', reversible: false, args: { tool: 'string — an admitted tool name/id', version: 'string — a version id from componentHistory' },
      description: 'Revert a component to an earlier VERSION of its source (non-destructive — a new version; history preserved; the live tool then runs it). Owner-only.' });
    toolbox.forkComponent = harden({ run: async ({ tool, name, version } = {}) => {
      const src = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!src) return { ok: false, error: `no admitted tool "${tool}"` };
      const newName = String(name || '').trim(); if (!newName) return { ok: false, error: 'give your fork a name' };
      const ref = String(version || 'HEAD');
      const snap = await componentGitObj.readAt(src.id, ref); const files = (snap && snap.files);
      if (!files) return { ok: false, error: 'could not read the source version (see componentHistory)' };
      const keys = Object.keys(files);
      const p = (keys.length === 1 && keys[0] === 'tool.js')
        ? customToolsObj.propose({ name: newName, description: `[fork of ${src.name}] ${src.description || ''}`, code: files['tool.js'], kind: 'instance', proposedBy: node.id, now: new Date().toISOString() })
        : customToolsObj.propose({ name: newName, description: `[fork of ${src.name}] ${src.description || ''}`, files, entry: 'tool.js', kind: 'class', proposedBy: node.id, now: new Date().toISOString() });
      if (!p.ok) return p;
      try { await componentGitObj.fork(src.id, p.id, ref); } catch { try { await componentGitObj.commit(p.id, files, `fork of ${src.name}`); } catch { /* ignore */ } }
      customToolsObj.copyGrains(src.id, p.id);
      return { ok: true, fork: newName, note: `Forked "${src.name}" → "${newName}" with its own version lineage + a COPY of the data. It's queued for the owner to review + admit. The original is untouched.` };
    } });
    manifest.push({ name: 'forkComponent', reversible: false, args: { tool: 'string — an admitted tool name/id', name: 'string — a name for your fork', version: 'string — OPTIONAL version to fork from (default latest; see componentHistory)' },
      description: 'FORK a component into a NEW one — its own git source lineage (forkable/revertable independently) + a COPY of the source\'s grain data. Enters review; admit to host it. The original is untouched.' });
    // componentReadFile / componentWriteFile — author a component through its FILE-OBJECT (the @endo/exo-git
    // mount): read or edit ONE file of its source tree, not the whole module. A write commits a new version
    // AND updates the live tool. Owner-only for writes (it changes a shared component).
    toolbox.componentReadFile = harden({ run: async ({ tool, path: rel, version } = {}) => {
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}"` };
      const snap = await componentGitObj.readAt(t.id, String(version || 'HEAD')); if (!snap) return { ok: false, error: 'unknown version' };
      if (rel) { const c = snap.files[String(rel)]; return c === undefined ? { ok: false, error: `no file "${rel}" (files: ${Object.keys(snap.files).join(', ')})` } : { ok: true, path: String(rel), content: c }; }
      return { ok: true, files: Object.keys(snap.files) };
    } });
    manifest.push({ name: 'componentReadFile', reversible: false, args: { tool: 'string — an admitted tool name/id', path: 'string — OPTIONAL file path (omit to LIST the files)', version: 'string — OPTIONAL version (default HEAD)' },
      description: 'Read a component\'s source through its FILE-OBJECT: a single file\'s content (path) or the file list (omit path), at any version. Read-only.' });
    toolbox.componentWriteFile = harden({ run: async ({ tool, path: rel, content, message } = {}) => {
      if (!node.isRoot) return { ok: false, error: 'editing a shared component\'s files is the owner\'s call.' };
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}"` };
      if (!String(rel || '').trim()) return { ok: false, error: 'name the file path to write' };
      let r; try { r = await componentGitObj.writeFile(t.id, String(rel), String(content ?? ''), String(message || `edit ${rel}`)); } catch (e) { return { ok: false, error: `write failed: ${(e && e.message) || e}` }; }
      customToolsObj.setSource(t.id, r.files); // sync the new git HEAD → the live tool
      return { ok: true, tool: t.name, path: String(rel), version: String(r.version).slice(0, 12), note: 'Wrote the file through the component\'s file-object, committed a new version, and updated the live tool. Revert from the Components tab if needed.' };
    } });
    manifest.push({ name: 'componentWriteFile', reversible: false, args: { tool: 'string — an admitted tool name/id', path: 'string — the file path to write (e.g. tool.js, helper.js)', content: 'string — the new file contents', message: 'string — OPTIONAL commit message' },
      description: 'Author a component through its FILE-OBJECT: write/replace ONE file of its source tree (not the whole module), commit a new version, and update the live tool. Owner-only.' });
    // requestAccess is ALSO always available — the escalation primitive. A confined cap CANNOT grant
    // itself powers; it ASKS the owner (dan), who approves from his inbox / the chat's powers banner.
    // This is the read-only-by-default + progressive-trust path: don't give up when you lack a power.
    toolbox.requestAccess = harden({ run: async ({ power, why } = {}) => {
      const raw = String(power || '').slice(0, 40); const reason = String(why || '').slice(0, 1000);
      if (!raw) return { ok: false, error: 'name the power you need' };
      const p = resolvePower(raw); // a verb name (e.g. proposeSystemPrompt) → its grantable POWER (selfPrompt)
      if (powers.has(p)) return { ok: true, alreadyHeld: true, note: `you already hold "${p}".` };
      const label = (POWERS[p] && POWERS[p].label) || p;
      await aff.feed.notify({ title: `🔓 ${node.id} requests the "${p}" power`, body: reason || '(no reason given)', agent: node.id, link: chatLink(ctx) });
      try { await aff.phone.push({ title: `🔓 power request: ${p}`, message: `${node.id}: ${reason}`.slice(0, 150), click: chatLink(ctx) || '' }); } catch { /* best-effort */ }
      // accessRequest → the server surfaces an ACTIONABLE Grant card in the chat (one-click grant, not just
      // a passive notification): the owner grants "p" to this chat in place. Returns the resolved power so
      // the agent reports the right name.
      return { ok: true, requested: p, accessRequest: { power: p, label, why: reason }, note: `Asked the owner to grant "${p}". A Grant prompt now appears in this chat — once approved, ask me again and I'll continue.` };
    } });
    manifest.push({ name: 'requestAccess', reversible: false,
      args: { power: 'string — the capability you need (e.g. notes, web, images, research)', why: 'string — why you need it (helps the owner decide)' },
      description: 'REQUEST a power you do NOT currently hold from the owner. You cannot grant yourself powers — this asks the owner, who approves or declines. Use this instead of giving up when a task needs a capability you lack.' });
    // ── WIDGETS — ALWAYS available. Emit a LIVE / INTERACTIVE widget into the chat bubble (vs plain text).
    //    These return a display SPEC only — they grant NO authority (the spec is pure data: labels, an
    //    entity handle, timer dueAts, choice strings). The live DATA flows separately + cap-gated: a door
    //    widget SUBSCRIBES to the ha:<handle> grain over /cells/subscribe, which only pushes if THIS chat
    //    holds the homeassistant power. So emitting a widget is safe even from a confined cap; it just
    //    won't show live data the cap isn't entitled to. Prefer these for status / timers / choices. ──
    toolbox.showEntityStatus = harden({ run: async ({ handle, label } = {}) => {
      const h = String(handle || '');
      if (!h) return { ok: false, error: 'need the entity handle — find it with haFind/search first' };
      // Verify reachability at DESIGNATION time (same c-list rule as haState/haAct) so a hallucinated /
      // out-of-reach handle fails legibly here instead of minting a broken "not reachable" widget.
      if (powers.has('homeassistant') && node.haReach && !node.haReach(h)) return { ok: false, error: 'that entity is not in your reach — find it with haFind first' };
      return { ok: true, widget: { type: 'entity-status', handle: h, label: String(label || 'status').slice(0, 60), cell: `ha:${h}` }, note: 'Rendered a LIVE status widget; it stays current in the chat (subscribes to the entity).' };
    } });
    toolbox.showCountdowns = harden({ run: async ({ timers } = {}) => {
      const items = (Array.isArray(timers) ? timers : []).map(t => ({ label: String((t && t.label) || 'timer').slice(0, 60), dueAt: String((t && (t.dueAt || t.dueAtISO || t.endTimeISO)) || '') })).filter(t => t.dueAt).slice(0, 12);
      if (!items.length) return { ok: false, error: 'need timers: [{label, dueAt(ISO)}] — e.g. from listTimers (use the once-timer dueAt)' };
      return { ok: true, widget: { type: 'countdowns', items }, note: 'Rendered live countdown timers; each ticks down on screen.' };
    } });
    toolbox.showChoices = harden({ run: async ({ prompt, options } = {}) => {
      const opts = (Array.isArray(options) ? options : []).map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, 8);
      if (!opts.length) return { ok: false, error: 'need options: an array of choice strings' };
      return { ok: true, widget: { type: 'choices', prompt: String(prompt || '').slice(0, 160), options: opts }, note: 'Rendered tappable choices; tapping one sends it back as the next message.' };
    } });
    // showComponent — render an ARBITRARY custom component you write, CONFINED in a sandboxed iframe and fed
    // by live grains. Use ONLY when a typed widget (status/countdown/choices) doesn't fit. The source is a
    // function `(ui) => ui.create('div')…` — ui gives you create(tag) [.text/.attr/.class/.style/.on/.push/
    // .follow(grain,fn)], grain(cellId) [a LIVE server cell — e.g. "ha:<handle>"], and local(initial) [client
    // state]. NO DOM, NO network, NO authority: you can only render + follow declared cells. Declare every
    // server cell you use in `cells` (they're cap-gated; an unreachable one is dropped here).
    toolbox.showComponent = harden({ run: async ({ source, cells, height, uses } = {}) => {
      const src = String(source || '');
      if (!/^\s*\(?\s*[a-zA-Z_$]/.test(src) || !src.includes('=>')) return { ok: false, error: 'source must be a function: (ui) => ui.create(...)' };
      if (src.length > 8000) return { ok: false, error: 'component source too long (keep it under 8000 chars)' };
      const dropped = [];
      // gate ha:<handle> cells at designation time (same c-list rule as showEntityStatus)
      const gateHa = c => { const m = /^ha:(.+)$/.exec(c); if (!m) return true; if (powers.has('homeassistant') && node.haReach && !node.haReach(m[1])) { dropped.push(c); return false; } return true; };
      let declared = (Array.isArray(cells) ? cells : []).map(String).slice(0, 8).filter(gateHa);
      // ui.use: REUSE prior broken-out components by AGENT-DECLARED ALIAS. Resolve each alias→uicomp source HERE
      // (server-side; the raw id NEVER reaches the client/frame), scrub it (render-safe), and fold the referenced
      // component's REACHABLE ha: cells into the brokered set so they re-pass the SAME gate under THIS cap — and
      // the server /cells/subscribe re-validates per-cap every heartbeat (the load-bearing data gate). One level deep.
      const usesMap = (uses && typeof uses === 'object' && !Array.isArray(uses)) ? uses : {};
      const scrub = s => String(s || '').replace(/#cap=[0-9a-fA-F]{16,}/g, '#cap=«redacted»').replace(/\b[0-9a-f]{32}\b/g, '«swissnum»');
      const refs = {};
      for (const alias of Object.keys(usesMap).slice(0, 4)) {
        const id = String(usesMap[alias] || ''); if (!id.startsWith('uicomp-')) continue;
        let snap = null; try { snap = await componentGitObj.readAt(id, 'HEAD'); } catch { /* */ }
        if (!snap || !snap.files || !snap.files['component.js'] || snap.files['component.js'].length > 8000) continue; // bound the injected ref source (defense-in-depth; matches the break-out cap)
        let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ }
        const refCells = (Array.isArray(meta.cells) ? meta.cells : []).map(String).filter(c => /^ha:/.test(c) && gateHa(c)); // ONLY reachable ha: cells fold in
        for (const c of refCells) if (!declared.includes(c)) declared.push(c);
        refs[String(alias)] = { source: scrub(snap.files['component.js']), cells: refCells };
      }
      const widget = { type: 'component', source: src, cells: declared.slice(0, 16), height: Math.min(2000, Math.max(40, Number(height) || 140)) };
      if (Object.keys(refs).length) widget.refs = refs; // {alias:{source,cells}} — NO raw id; source is render-safe + scrubbed
      const reused = Object.keys(refs).length;
      return { ok: true, widget, note: `Rendered a custom confined component${reused ? ` (reused ${reused} saved component(s) via ui.use)` : ''}${dropped.length ? ` (dropped unreachable cells: ${dropped.join(', ')} — haFind them first)` : ''}.` };
    } });
    // showThemePreview — propose a NEW global THEME (the user's style). Renders a before/after preview with
    // accept/reject; the vars are pure style data (CSS custom properties), never authority.
    toolbox.showThemePreview = harden({ run: async ({ name, vars, mode } = {}) => {
      const v = (vars && typeof vars === 'object' && !Array.isArray(vars)) ? vars : null;
      if (!v) return { ok: false, error: 'provide vars: an object of CSS custom properties, e.g. {"--bg":"#1a1410","--panel":"#241c14","--edge":"#3a2e20","--ink":"#f0e6d2","--mut":"#a8957a","--acc":"#c98a3a","--acc2":"#6a8a3a","--bad":"#cf5a3a","--you":"#3a6a9a"}.' };
      const clean = {}; for (const k of Object.keys(v)) { if (/^--[\w-]+$/.test(k) && typeof v[k] === 'string' && v[k].length <= 60) clean[k] = v[k]; }
      if (!Object.keys(clean).length) return { ok: false, error: 'no valid CSS custom properties (keys must look like --bg with short string values)' };
      return { ok: true, widget: { type: 'theme-preview', name: String(name || 'custom').slice(0, 40), mode: (mode === 'light' || mode === 'dark') ? mode : undefined, vars: clean }, note: 'Showed a before/after theme preview with accept/reject — the user decides whether to apply it globally.' };
    } });
    manifest.push(
      { name: 'showThemePreview', reversible: false, args: { name: 'string — a short name for the theme', vars: 'object — CSS custom properties to preview. Themeable keys: --bg (page) --panel (cards) --edge (borders) --ink (text) --mut (muted text) --acc (accent/buttons) --acc2 (good) --bad (errors) --you (your bubble). Give the FULL set for a coherent look, e.g. a warm theme: {"--bg":"#1a1410","--panel":"#241c14","--edge":"#3a2e20","--ink":"#f0e6d2","--mut":"#a8957a","--acc":"#c98a3a","--acc2":"#6a8a3a","--bad":"#cf5a3a","--you":"#3a6a9a"}', mode: 'string — OPTIONAL "light" or "dark" (else inferred from --bg brightness)' }, description: 'Propose a NEW THEME (the user\'s global style) as a BEFORE/AFTER preview with Accept/Reject. On accept it becomes the user\'s live style EVERYWHERE (page + all components, which read these vars). Use whenever the user asks to change colors / restyle / make a theme.' },
      { name: 'showEntityStatus', reversible: false, args: { handle: 'string — an entity handle from haFind/search', label: 'string — a short title (e.g. "Front door")' }, description: 'Show a LIVE status WIDGET for a Home Assistant entity (door/lock/sensor/light). It stays current — when reopened later it re-subscribes and shows the latest state, no refresh needed. Prefer this over a text answer for any "is X open / on / locked?" question. Get the handle from haFind first.' },
      { name: 'showCountdowns', reversible: false, args: { timers: 'array — [{label, dueAt}] where dueAt is an absolute ISO time (use the dueAt from a "once" timer in listTimers)' }, description: 'Show LIVE COUNTDOWN widgets that tick down on screen toward each dueAt (great for cooking steps / timers you just set). Pass each timer\'s label + absolute dueAt.' },
      { name: 'showChoices', reversible: false, args: { prompt: 'string — the question', options: 'array — choice strings' }, description: 'Show tappable CHOICE buttons; when the user taps one it is sent back as their next message. Use for "pick one" / "which would you like?" answers instead of listing options as text.' },
      { name: 'showComponent', reversible: false, args: { source: 'string — a function (ui) => ui.create(...). ui.create(tag) → element with .text(s)/.attr(k,v)/.class(c)/.style({...})/.on(event,fn)/.push(children)/.follow(grain, v=>text). ui.island(name, props, children) → a THEMED design-system primitive so it matches the app — name ∈ [Card, Btn, Chip, Badge, Banner, Meta, Stack, Row, Divider, EmptyState, ProgressBar, Field, TextField]; PREFER these over raw create() for a consistent look. ui.use(alias) → render a PRIOR saved component you referenced in `uses` (e.g. ui.use("door")). ui.grain(cellId) → a LIVE server cell (e.g. "ha:<handle>" — follow it). ui.local(initial) → client state.', cells: 'array — the server cell ids your component will follow (e.g. ["ha:<handle>"]); declare them so the live data is brokered + cap-gated', uses: 'object — OPTIONAL {alias: componentId} map (ids from listComponents) to REUSE saved components live; call ui.use(alias) in your source. Up to 4. Their data still re-gates by what you hold.', height: 'number — initial px height (it auto-grows)' }, description: 'Render a CUSTOM component you write — confined + safe (sandboxed; no DOM/network/authority) and ALWAYS available regardless of your powers (building UI is a free right; only the DATA it draws via ui.grain is gated by what you hold). Compose the themed kit with ui.island, and REUSE a saved component live with `uses` + ui.use(alias) (listComponents to find ids). Use when status/countdown/choices don\'t fit. It can FOLLOW live grains and be broken out + shared.' },
    );
    // listComponents / readComponent — the LIBRARY of prior broken-out UI components, so you REUSE instead of
    // reinventing (reuse-first). ALWAYS available (incl. delegates): a uicomp id carries NO authority and the
    // source is render-safe (+ scrubbed); the DATA a reused component draws still re-gates by what the cap holds.
    toolbox.listComponents = harden({ run: async () => {
      let ids = []; try { ids = (await componentGitObj.list()).filter(id => String(id).startsWith('uicomp-')); } catch { return { ok: true, components: [] }; }
      const out = [];
      for (const id of ids.slice(0, 60)) { try { const snap = await componentGitObj.readAt(id, 'HEAD'); if (!snap) continue; let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ } out.push({ id, name: meta.name || id, cells: Array.isArray(meta.cells) ? meta.cells : [] }); } catch { /* skip unreadable */ } }
      return { ok: true, components: out };
    } });
    toolbox.readComponent = harden({ run: async ({ id } = {}) => {
      const cid = String(id || ''); if (!cid.startsWith('uicomp-')) return { ok: false, error: 'pass a uicomp- id from listComponents' };
      const snap = await componentGitObj.readAt(cid, 'HEAD'); if (!snap || !snap.files['component.js']) return { ok: false, error: 'no such component' };
      let meta = {}; try { meta = JSON.parse(snap.files['manifest.json'] || '{}'); } catch { /* */ }
      const scrub = s => String(s || '').replace(/#cap=[0-9a-fA-F]{16,}/g, '#cap=«redacted»').replace(/\b[0-9a-f]{32}\b/g, '«swissnum»'); // defensive: components are render-safe, but never let a swissnum ride into the agent/DOM
      return { ok: true, id: cid, name: meta.name || cid, cells: Array.isArray(meta.cells) ? meta.cells : [], source: scrub(snap.files['component.js']) };
    } });
    manifest.push(
      { name: 'listComponents', reversible: false, args: {}, description: 'List the saved/broken-out UI components in the library (id, name, declared cells) so you can REUSE one instead of rewriting it.' },
      { name: 'readComponent', reversible: false, args: { id: 'string — a uicomp- id from listComponents' }, description: 'Read a saved component\'s SOURCE (a (ui)=>element function) so you can reuse/adapt its pattern inside your own showComponent. Render-safe code only.' },
    );
    // proposeTool — ALWAYS available. Build a new tool (a pure JS function of `args`) and propose it to
    // the library. It is NOT injected into anyone's scope or made callable; it queues PENDING for dan to
    // REVIEW the code, then admit. (A delegate's proposals are also RETURNED by delegateTask as data.)
    toolbox.proposeTool = harden({ run: async ({ name: tname, description, code, args, kind, files, entry } = {}) => {
      const multi = files && typeof files === 'object' && Object.keys(files).length;
      if (!multi && !String(code || '').trim()) return { ok: false, error: 'A tool IS a component. PREFER `files` — a file-tree {"tool.js":"export const make = async (powers) => {…}", "helper.js":"…"} (the entry exports make + may import siblings) — over a single `code` blob; the source becomes a VERSIONED git object (fork/revert in the Components tab). Persist DATA in powers.grains (durable, mergeable, subscribable cells that SURVIVE source edits/reverts — the propagator data model), not ad-hoc state. Confined: no fs/network/import.' };
      const r = customToolsObj.propose({ name: tname, description, code, args, kind, files, entry, proposedBy: node.id, proposedByName: node.name, now: new Date().toISOString() });
      // A tool IS a component: version its SOURCE as a git-as-Endo object from the moment it's proposed
      // (not just on admit), so it's forkable/revertable from birth — matching the component API.
      if (r.ok !== false && r.id) { try { await componentGitObj.commit(r.id, multi ? files : { 'tool.js': String(code || '') }, `propose: ${r.name}`); } catch { /* git-versioning is best-effort here; admit re-commits */ } }
      // The tool goes UP to Agent C's pipeline, not a proposal card at the owner: it enters autonomous review,
      // and the review panel (not a manual click) is the gate — a non-critical tool is auto-admitted to the
      // library, with Agent C naming/organizing it. The disposition is logged to the "internal messages" chat
      // (Settings → Internal messages), so the owner can watch what the fleet builds without being interrupted.
      try { postInternal({ from: node.name || 'agent', kind: 'tool-proposed', title: `proposed a ${r.kind} tool: "${r.name}"`, body: String(description || '').slice(0, 400), toolId: r.id, by: node.name, status: 'entering review' }); } catch { /* best-effort */ }
      return { ok: true, proposed: true, id: r.id, name: r.name, kind: r.kind, multifile: r.multifile, note: 'Saved + sent up to Agent C\'s review pipeline. The review panel is the gate: a non-critical tool is AUTO-ADMITTED to the library (Agent C names/organizes it) — no owner click needed. Watch its disposition in Settings → Internal messages.' };
    } });
    manifest.push({ name: 'proposeTool', reversible: false,
      args: { name: 'string — tool name', description: 'string — what it does', kind: 'string — "instance" (one stateful object hosted here) or "class" (shareable; others instantiate locally)', code: 'string — for a single-file tool: a `make(powers)` BODY returning your tool (fn or {methods})', files: 'object — for a MULTI-FILE class: {"tool.js":"export const make = async (powers) => {…}", "helper.js":"export const …"} — the entry exports make + may import siblings', entry: 'string — entry file for files (default tool.js)', args: 'object — its arg/method schema' },
      description: 'PROPOSE a new STATEFUL tool — which IS a COMPONENT: its source becomes a VERSIONED git-as-Endo object the instant you propose it (fork/revert/edit it later from the Components tab, like any component). `make(powers)` → a persistent object (NOT a one-shot fn). PREFER the `files` file-tree form over a single `code` blob (entry tool.js exports make + may import siblings; bundled as a real multi-module Endo SMR bundle, shareable). For DATA, PREFER powers.grains (the propagator data model) over the state kv — durable, mergeable, subscribable cells: `const c = powers.grains.cell("count",{merge:"sum"}); c.addContent(1); c.read()` (merges: lastWriteWins|max|min|sum|append|union). Grains are the component\'s DATA, kept SEPARATE from the source, so they SURVIVE a revert/edit and are portable across forks. Queued for the owner to REVIEW + admit — never auto-injected.' });
    // systemMap — ALWAYS available, read-only. The whole system's shape: every power+verbs, the roles +
    // their default rings, the default endowment per agent type, and the canonical review/process flows.
    // Use it to MAP/GRAPH the system (agents as nodes, endowments as held powers, flows as edges).
    toolbox.systemMap = harden({ run: async () => ({ ok: true, ...buildSystemMap({ ALL_POWERS, POWERS, META_POWERS, roleList, specialists }) }) });
    manifest.push({ name: 'systemMap', reversible: false, args: {},
      description: 'Introspect the WHOLE system as structured data: the full power catalog (each power → its verbs + whether it is meta), the roles + their default tool rings, the default endowment per agent type (entry agent, invitee, role, specialist, delegate), and the canonical review/escalation/billing FLOWS. Use this to generate a graph/map of the agents, their default endowments, and how review flows through the system.' });
    // generic cross-object SEARCH — fan out to EVERY searchable object this cap holds
    // (notes, contacts, Home Assistant, agent roster, Kazputer). search() is a standard
    // interface; FIND a thing here before assuming where it lives (e.g. don't hunt HA).
    toolbox.search = harden({ run: async ({ query } = {}) => {
      const q = String(query || ''); const results = [];
      const push = (source, arr) => { for (const x of (arr || [])) results.push({ source, ...x }); };
      // FIRST, search your own TOOLS — this is the agent's search engine, so the most useful hit for
      // "how do I X?" is usually a VERB you already hold. Token-overlap rank over name + description.
      const toks = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
      if (toks.length) {
        const scored = manifest.map(m => {
          const hay = `${m.name} ${m.description || ''} ${Object.values(m.args || {}).join(' ')}`.toLowerCase();
          let score = 0; for (const w of toks) { if (m.name.toLowerCase().includes(w)) score += 3; else if (hay.includes(w)) score += 1; }
          return { m, score };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
        push('tools', scored.map(x => ({ name: x.m.name, description: x.m.description, args: x.m.args })));
      }
      try { if (powers.has('notes')) push('notes', (await aff.notes.search(q, { limit: 8 })).map(n => ({ name: n.title, path: n.path }))); } catch (e) { results.push({ source: 'notes', error: `notes search failed (${(e && e.message) || e}) — your notes were NOT searched this time; retry`, name: '' }); } // surface, don't silently drop notes (the "search returned []" bug)
      // SURFACE failures (don't silently drop a source — same principle as the notes "search returned []" fix):
      // a silently-skipped source LOOKS like "it isn't searched", which is exactly the HA-in-search confusion.
      try { if (powers.has('contacts') && contactsObj) push('contacts', await contactsObj.search(q)); } catch (e) { results.push({ source: 'contacts', error: `contacts search failed (${(e && e.message) || e}) — retry`, name: '' }); }
      try { if (powers.has('homeassistant')) { const s = node.haStart(); if (s && s.search) push('homeassistant', await s.search(q)); else results.push({ source: 'homeassistant', error: 'Home Assistant isn’t ready yet (the device trie is still building at boot, or HA is unconfigured) — your devices were NOT searched; retry in a moment', name: '' }); } } catch (e) { results.push({ source: 'homeassistant', error: `Home Assistant search failed (${(e && e.message) || e}) — your devices were NOT searched this time; retry`, name: '' }); }
      try { if (powers.has('agents')) { const s = node.agStart(); if (s && s.search) push('agents', await s.search(q)); } } catch (e) { results.push({ source: 'agents', error: `agents search failed (${(e && e.message) || e})`, name: '' }); }
      try { if (powers.has('kazputer') && kazAdmin) push('kazputer', await kazAdmin.search(q)); } catch (e) { results.push({ source: 'kazputer', error: `kazputer search failed (${(e && e.message) || e})`, name: '' }); }
      return { ok: true, query: q, results: results.slice(0, 40) };
    } });
    manifest.push({ name: 'search', reversible: false, args: { query: 'string — what to find, or a capability you need ("set a timer", "push to my phone")' }, description: 'Your SEARCH ENGINE: search ACROSS everything in ONE call — FIRST your own available TOOLS/verbs (so "how do I X?" surfaces the right verb to call), then your notes, contacts, Home Assistant, agent roster, and Kazputer. Returns matches tagged by source (source:"tools" = a verb you can call right now). Use this to find the RIGHT TOOL or a thing before acting — don\'t assume where something lives.' });
    return { toolbox: harden(toolbox), manifest: harden(manifest) };
  };

  // A node = a holder of a SUBSET of powers, with the right to use + re-share
  // them. The root holds ALL_POWERS. share() mints a child node (single power).
  const makeAgentNode = ({ powers, labelOf = 'agent', name = '', isRoot = false, haBinding = null, agBinding = null, contactsBinding = null, homeBinding = null, timersBinding = null, notesBinding = null, cwdBinding = null, id = null }) => {
    const powerSet = new Set(powers);
    const shares = new Map(); // swiss → { power, label, createdAt, url, ha? }
    // homeBinding = () → this cap's home folder object (its own sub-dir).
    const home = homeBinding || (() => makeHome(isRoot ? 'root' : `cap-${labelOf}`.replace(/[^\w-]/g, '_').slice(0, 40)));
    const node = { powers: powerSet, isRoot, haBinding, agBinding, contactsBinding, homeBinding: home, timersBinding, notesBinding, cwdBinding };
    // Stable agent identity for auto-confirm rules. Must be UNIQUE per cap — shares
    // pass their swissnum as `id` so two same-LABEL shares don't collide (and thus
    // can't leak one's "don't ask again" rule onto the other). Specialists pass no
    // `id`, so they keep their persisted unique slug (labelOf); root is 'root'.
    node.id = isRoot ? 'root' : (id || labelOf);
    // A human DISPLAY name distinct from the stable id — so attributions (feed, internal messages, trace) read
    // descriptively instead of "scoped-9786c66e". Derived without an LLM: an explicit name, else a humanized
    // labelOf, else the id. Callers (mintScopedCap, delegates, specialists) pass a context-derived name.
    node.name = isRoot ? 'Agent C' : (String(name || '').trim() || String(labelOf || '').replace(/^(chat|improve-exec)-/, '').replace(/[_-]+/g, ' ').trim() || node.id);

    // ── C-LIST: the set of HA handles this cap may name. Seeded with the held
    //    node; grows ONLY by navigating down from it. Enforces that authority is
    //    bounded by what you hold, independent of handle guessability. ──────────
    node.haCList = new Set();
    node.haStart = () => { const r = node.haBinding?.(); if (r) node.haCList.add(r.describe().handle); return r || null; };
    node.haReach = handle => { if (!node.haCList.has(String(handle || ''))) return null; return haTrie?.nodeByHandle(handle) || null; };
    node.haLearn = desc => { if (!desc) return desc; node.haCList.add(desc.handle); (desc.rooms || []).forEach(r => node.haCList.add(r.handle)); (desc.types || []).forEach(t => node.haCList.add(t.handle)); (desc.entities || []).forEach(e => node.haCList.add(e.handle)); return desc; };

    // Same c-list confinement for the agent-personas roster (separate namespace).
    node.agCList = new Set();
    node.agStart = () => { const r = node.agBinding?.(); if (r) node.agCList.add(r.describe().handle); return r || null; };
    node.agReach = handle => { if (!node.agCList.has(String(handle || ''))) return null; return agentRoster?.nodeByHandle(handle) || null; };
    node.agLearn = desc => { if (!desc) return desc; node.agCList.add(desc.handle); (desc.agents || []).forEach(a => node.agCList.add(a.handle)); return desc; };

    node.share = (power, label) => {
      if (!powerSet.has(power)) throw new Error(`you don't hold the power "${power}" (have: ${[...powerSet].join(', ') || 'none'})`);
      const clean = String(label || '').trim().slice(0, 80);
      if (!clean) throw new Error('a name is required for an invite link (so you can recognize it to revoke later)');
      const swiss = newSwiss();
      // Sharing the whole homeassistant power hands over this cap's HA binding
      // (the root's = the whole trie). Fine-grained HA sharing uses shareHa().
      const childHa = power === 'homeassistant' ? node.haBinding : null;
      const childAg = power === 'agents' ? node.agBinding : null;
      const child = makeAgentNode({ powers: [power], labelOf: clean, haBinding: childHa, agBinding: childAg, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power, label: clean, createdAt: new Date().toISOString(), url });
      return { power, label: clean, swiss, url };
    };

    // OBJECT-DESIGNATED HomeAssistant share: hand someone a specific trie NODE
    // (a room / type / single entity), optionally read-only, by its web-key
    // HANDLE — not a string the server re-resolves. You can only share a node you
    // hold, because the only handles you know are ones you discovered by drilling
    // into your own binding. readOnly attenuates recursively (children too).
    node.shareHa = (handle, label, { readOnly = false } = {}) => {
      if (!powerSet.has('homeassistant')) throw new Error("you don't hold homeassistant");
      const target = node.haReach(handle); // you can only share a node you've REACHED (c-list)
      if (!target) throw new Error('HA node not in your reach — navigate to it (haTree) first');
      const clean = String(label || '').trim().slice(0, 80);
      if (!clean) throw new Error('a name is required for a share link');
      const bound = readOnly ? target.readOnly() : target;
      const d = bound.describe();
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['homeassistant'], labelOf: clean, haBinding: () => bound, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'homeassistant', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: d.kind, name: d.name || d.entity_id || d.label, readOnly: !!readOnly } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    // OBJECT-DESIGNATED agent-persona share (same web-key model as shareHa).
    node.shareAgent = (handle, label, { readOnly = false } = {}) => {
      if (!powerSet.has('agents')) throw new Error("you don't hold agents");
      const target = node.agReach(handle);
      if (!target) throw new Error('agent node not in your reach — navigate to it first');
      const clean = String(label || '').trim().slice(0, 80);
      if (!clean) throw new Error('a name is required for a share link');
      const bound = readOnly ? target.readOnly() : target;
      const d = bound.describe();
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['agents'], labelOf: clean, agBinding: () => bound, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'agents', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: d.kind, name: d.name || d.label, readOnly: !!readOnly } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    // OBJECT-DESIGNATED contact share: hand someone ONE contact as a read-only granule.
    // The minted cap holds the `contacts` power but its binding is scoped to a single contact —
    // search/get see only it, and propose-add/edit are refused (read-only). A real "smaller granule".
    node.shareContacts = async (handle, label) => {
      if (!powerSet.has('contacts')) throw new Error("you don't hold contacts");
      const b = node.contactsBinding && node.contactsBinding();
      if (!b) throw new Error('address book unavailable');
      const c = await b.get(String(handle || ''));
      if (!c) throw new Error('contact not in your reach');
      const clean = String(label || c.fn || c.org || 'contact').trim().slice(0, 80);
      // a frozen, read-only one-contact view with the same shape contacts verbs expect
      const one = harden({ readOnly: true, count: async () => 1,
        search: async () => [c], get: async h => (String(h) === String(c.handle) ? c : null) });
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['contacts'], labelOf: clean, contactsBinding: () => one, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'contacts', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: 'contact', name: c.fn || c.org || c.emails?.[0] || clean, readOnly: true } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    // OBJECT-DESIGNATED home share: hand someone ONE folder or file from your home, read-only.
    // The minted cap holds the `home` power but its binding is a read-only sub-view (subtree or
    // single file) — fileWrite/publishSite are absent, and the path-guard confines it. A granule.
    node.shareHome = (subpath, label) => {
      if (!powerSet.has('home')) throw new Error("you don't hold home");
      const h = node.homeBinding && node.homeBinding();
      if (!h || !h.share) throw new Error('home folder unavailable');
      let bound; try { bound = h.share(String(subpath || '')); } catch (e) { throw new Error(`path not in your home: ${e.message}`); }
      const clean = String(label || subpath || 'files').trim().slice(0, 80);
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['home'], labelOf: clean, homeBinding: () => bound, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'home', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: 'files', name: String(subpath || 'home'), readOnly: true } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    // OBJECT-DESIGNATED timer share: hand someone ONE timer — they can VIEW + CANCEL it, but
    // cannot schedule new ones or see your other timers. The binding scopes list/cancel to the id.
    node.shareTimers = async (id, label) => {
      if (!powerSet.has('timers')) throw new Error("you don't hold timers");
      const tid = String(id || '');
      const cur = (node.timersBinding && node.timersBinding()) || aff.timers;
      const all = await cur.list();
      const t = (all || []).find(x => x.id === tid);
      if (!t) throw new Error('timer not in your reach');
      const noNew = async () => harden({ ok: false, error: 'this share can only view/cancel its one timer' });
      const one = harden({
        list: async () => harden(((await cur.list()) || []).filter(x => x.id === tid)),
        cancel: async cid => (String(cid) === tid ? cur.cancel(tid) : harden({ ok: false, error: 'not in this share' })),
        schedule: noNew, repeat: noNew,
      });
      const clean = String(label || t.label || tid).trim().slice(0, 80);
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['timers'], labelOf: clean, timersBinding: () => one, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'timers', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: 'timer', name: t.label || tid, readOnly: false } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    // OBJECT-DESIGNATED notes share: hand someone a vault SUBTREE (a folder or one note),
    // READ-ONLY. The minted cap holds `notes` bound to a view whose search is filtered to the
    // prefix and whose read refuses anything outside it. A real "share just this folder/note".
    node.shareNotes = (subpath, label) => {
      if (!powerSet.has('notes')) throw new Error("you don't hold notes");
      const cur = (node.notesBinding && node.notesBinding()) || aff.notes;
      const base = cur.prefix || '';
      const pfx = String(subpath || base || '').replace(/^\/+/, '').replace(/\/+$/, '');
      if (base && pfx !== base && !underPrefix(pfx, base)) throw new Error('path not in your reach');
      const view = harden({
        prefix: pfx,
        search: async (q, opts) => harden((((await aff.notes.search(q, opts)) || []).filter(r => underPrefix(r.path, pfx)))),
        read: async rel => (underPrefix(String(rel || ''), pfx) ? aff.notes.read(rel) : ''),
        stats: async () => aff.notes.stats(),
      });
      const clean = String(label || pfx || 'notes').trim().slice(0, 80);
      const swiss = newSwiss();
      const child = makeAgentNode({ powers: ['notes'], labelOf: clean, notesBinding: () => view, id: swiss });
      locator.set(swiss, { node: child });
      const url = `${baseUrl}/#cap=${swiss}`;
      shares.set(swiss, { power: 'notes', label: clean, createdAt: new Date().toISOString(), url, ha: { kind: 'notes', name: pfx || 'vault', readOnly: true } });
      return { label: clean, swiss, url, ha: shares.get(swiss).ha };
    };

    node.listShares = () => [...shares.entries()]
      .filter(([swiss]) => locator.has(swiss))
      .map(([swiss, s]) => ({ swiss, power: s.power, label: s.label, createdAt: s.createdAt, url: s.url, ha: s.ha || null }));
    node.revoke = swiss => { const k = String(swiss); const had = locator.delete(k); shares.delete(k); return { revoked: had }; };

    // The management cap (what /rpc dispatches against). describe() never leaks
    // a child swissnum except via listShares (the panel needs it to revoke).
    node.cap = Far(`FieldAgentNode(${labelOf})`, {
      help: () => `Field agent node. Powers held: ${[...powerSet].join(', ') || 'none'}. describe(), share(power,name), listShares(), revoke(swiss)${powerSet.has('homeassistant') ? ', haTree(handle?), shareHa(handle,name,{readOnly})' : ''}.`,
      describe: () => harden({
        kind: powerSet.size === ALL_POWERS.length ? 'root' : 'share',
        label: labelOf,
        powers: [...powerSet].map(p => ({ name: p, label: POWERS[p].label })),
        canMint: [...powerSet],
        hasHomeAssistant: powerSet.has('homeassistant'),
        hasAgents: powerSet.has('agents'),
      }),
      share: (power, label) => harden((({ power: p, label: l, swiss, url }) => ({ power: p, label: l, swiss, url }))(node.share(power, label))),
      // Browse the object tree(s) this cap holds so the Shares panel (a filesystem
      // navigator) can pick a node to share. Restricted to the held binding's c-list.
      haTree: async handle => {
        const start = handle ? node.haReach(handle) : node.haStart();
        if (!start) throw new Error(handle ? 'handle not in your reach' : 'no HomeAssistant held');
        return harden(node.haLearn(await start.describe()));
      },
      shareHa: (handle, label, opts) => harden(node.shareHa(handle, label, opts || {})),
      agentsTree: async handle => {
        const start = handle ? node.agReach(handle) : node.agStart();
        if (!start) throw new Error(handle ? 'handle not in your reach' : 'no agents held');
        return harden(node.agLearn(await start.describe()));
      },
      // Browse the address book as a navigable object (root → contacts → a contact's details). Read-only:
      // the CardDAV write path is the contacts power's propose-add/edit, not a share here.
      contactsTree: async handle => {
        const cb = node.contactsBinding && node.contactsBinding();
        if (!cb || !powerSet.has('contacts')) throw new Error('no contacts held');
        if (!handle) {
          const list = await cb.search('');
          const label = c => c.fn || c.org || (c.emails || [])[0] || (c.tels || [])[0] || `contact ${String(c.handle).slice(0, 6)}`;
          return harden({ kind: 'contacts', name: 'Contacts', children: (list || []).map(c => ({ handle: c.handle, label: label(c), kind: 'contact' })) });
        }
        const c = await cb.get(String(handle));
        if (!c) throw new Error('contact not found');
        return harden({ kind: 'contact', name: c.fn || c.org || c.emails?.[0] || `contact ${String(handle).slice(0, 6)}`, handle: String(handle), emails: c.emails || [], tels: c.tels || [], org: c.org || '', note: c.note || '' });
      },
      // Browse the home folder as a navigable tree (root → folders/files). The handle is the
      // sub-path; the binding's path-guard confines a scoped (shared) home to its own subtree.
      homeTree: async handle => {
        const h = node.homeBinding && node.homeBinding();
        if (!h || !powerSet.has('home')) throw new Error('no home folder held');
        const rel = String(handle || '');
        const r = await h.list(rel);
        if (!r || !r.ok) throw new Error((r && r.error) || 'cannot list this folder');
        const join = n => (rel ? `${rel}/${n}` : n);
        return harden({ kind: rel ? 'home-folder' : 'home', name: rel || 'Files', handle: rel,
          children: (r.entries || []).map(e => ({ handle: join(e.name), label: e.name, kind: e.dir ? 'folder' : 'file', dir: !!e.dir, sub: e.dir ? 'folder' : 'file', leaf: !e.dir })) });
      },
      // Browse your durable timers as a tree (each timer a leaf). Scoped by the timers binding.
      timersTree: async handle => {
        if (!powerSet.has('timers')) throw new Error('no timers held');
        const cur = (node.timersBinding && node.timersBinding()) || aff.timers;
        const all = (await cur.list()) || [];
        if (!handle) return harden({ kind: 'timers', name: 'Timers', children: all.filter(t => t.status !== 'cancelled').map(t => ({ handle: t.id, label: t.label || t.id, kind: 'timer', leaf: true, sub: t.kind === 'interval' ? `every ${Math.round((t.everyMs || 0) / 1000)}s` : (t.dueAt || 'once') })) });
        const t = all.find(x => x.id === String(handle));
        if (!t) throw new Error('timer not found');
        return harden({ kind: 'timer', name: t.label || t.id, handle: String(handle), timerKind: t.kind, fires: t.kind === 'interval' ? t.nextAt : t.dueAt, status: t.status });
      },
      // Browse the personal vault as a tree (folders → notes). Confined to this cap's notes
      // binding prefix (a share sees only its subtree). Dotfiles (.obsidian/.git) are hidden.
      notesTree: async handle => {
        if (!powerSet.has('notes')) throw new Error('no notes held');
        const b = (node.notesBinding && node.notesBinding()) || aff.notes;
        const base = b.prefix || '';
        const rel = String(handle || base || '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (base && rel !== base && !underPrefix(rel, base)) throw new Error('escapes your share');
        const abs = vaultReadPath(rel);
        let ents = []; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { throw new Error(`cannot list: ${e.message}`); }
        const join = n => (rel ? `${rel}/${n}` : n);
        const all = ents
          .filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.name.endsWith('.md')))
          .map(e => ({ handle: join(e.name), label: e.name.replace(/\.md$/, ''), kind: e.isDirectory() ? 'folder' : 'note', dir: e.isDirectory(), leaf: !e.isDirectory(), sub: e.isDirectory() ? 'folder' : 'note' }))
          .sort((a, b) => (a.dir === b.dir ? a.label.localeCompare(b.label) : a.dir ? -1 : 1));
        const CAP = 400; // bound huge folders (the vault root has ~18k loose notes); folders sort first so they all show
        const children = all.slice(0, CAP);
        return harden({ kind: rel ? 'notes-folder' : 'notes', name: rel || 'Notes', handle: rel, children, truncated: all.length > CAP ? all.length - CAP : 0 });
      },
      shareAgent: (handle, label, opts) => harden(node.shareAgent(handle, label, opts || {})),
      shareContacts: async (handle, label) => harden(await node.shareContacts(handle, label)),
      shareHome: (subpath, label) => harden(node.shareHome(subpath, label)),
      shareTimers: async (id, label) => harden(await node.shareTimers(id, label)),
      shareNotes: (subpath, label) => harden(node.shareNotes(subpath, label)),
      listShares: () => harden(node.listShares()),
      revoke: swiss => harden(node.revoke(swiss)),
      // "don't ask again" rules for THIS agent — the inventory view + revoke control
      listAutoConfirm: () => harden(listAutoRules(node.id)),
      revokeAutoConfirm: kind => harden({ revoked: removeAutoRule(node.id, String(kind || '')), kind: String(kind || '') }),
      // the entry agent's specialist roster (inventory) — list + retire
      listSpecialists: () => harden((node.isRoot || powerSet.has('specialists')) ? [...builtinList(), ...specialists.map(s => ({ id: s.id, name: s.name, domain: s.domain, powers: s.powers, autonomy: listAutoRules(s.id).map(r => r.kind), spawnedFrom: s.spawnedFrom || null }))] : []),
      removeSpecialist: ref => { if (!node.isRoot && !powerSet.has('specialists')) throw new Error("you don't hold specialists"); return harden(removeSpecialist(ref)); },
    });

    // The per-turn toolbox + manifest for the LLM (only this node's powers).
    node.toolbox = ctx => toolboxAndManifestFor(powerSet, node, ctx);
    return node;
  };

  const rootNode = makeAgentNode({ powers: ALL_POWERS, labelOf: 'root', isRoot: true, haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null, contactsBinding: () => contactsObj });

  // ── specialist lifecycle (uses makeAgentNode + the locator) ─────────────────
  // Build a specialist's node: confined to its granted powers, its own id (so its
  // proposals + auto-confirm rules scope to it), inheriting the root HA/agent bindings.
  const registerSpecialist = spec => {
    const node = makeAgentNode({ powers: spec.powers, labelOf: spec.id, id: spec.id, haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null });
    specNodes.set(spec.id, node);
    if (spec.swiss) locator.set(spec.swiss, { node }); // its own invite link — directly addressable
    return node;
  };
  const getSpecNode = spec => specNodes.get(spec.id) || registerSpecialist(spec);
  const spawnSpecialist = ({ name, domain, powers, instructions, spawnedFromChatId }) => {
    const id = specSlug(name);
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p) && !META_POWERS.has(p)))];
    const existing = specialists.find(s => s.id === id);
    const swiss = existing?.swiss || newSwiss();
    const spec = { id, name: String(name || id), domain: String(domain || ''), powers: granted, instructions: String(instructions || ''), swiss, createdAt: existing?.createdAt || new Date().toISOString(), spawnedFrom: existing?.spawnedFrom || (spawnedFromChatId ? String(spawnedFromChatId) : null) };
    specialists = specialists.filter(s => s.id !== id).concat(spec);
    saveSpecialists();
    registerSpecialist(spec);
    return harden({ ok: true, id, name: spec.name, powers: granted, url: `${baseUrl}/#cap=${swiss}` });
  };
  const removeSpecialist = ref => {
    const spec = findSpecialist(ref);
    if (!spec) return harden({ ok: false, error: 'no such specialist' });
    specialists = specialists.filter(s => s.id !== spec.id);
    saveSpecialists();
    if (spec.swiss) locator.delete(spec.swiss);
    specNodes.delete(spec.id);
    return harden({ ok: true, id: spec.id });
  };
  // Run a specialist (gemma) with ITS confined bundle + ITS instructions. Its proposals
  // / auto-fires are scoped to its id and bubble up to the caller's turn (server merges).
  const makeAskSpecialist = (origin = '') => {
    let active = null;
    return {
      run: async ({ name, request } = {}) => {
        const spec = findSpecialist(name);
        if (!spec) return { ok: false, error: `no specialist "${name}" — list them with listSpecialists` };
        const sub = getSpecNode(spec).toolbox();
        const proposalIds = []; const autoFired = []; const toolsUsed = [];
        const ac = new AbortController(); active = ac;
        // Carry the originating request so the specialist's record shows what led to it.
        const lead = origin ? `The user's original request that led to this (context):\n"${String(origin).slice(0, 1200)}"\n\nWhat I'm asking you to do:\n` : '';
        try {
          const r = await AGENT_RUNNER({ toolbox: sub.toolbox, manifest: sub.manifest, userText: lead + String(request || ''), persona: spec.instructions, signal: ac.signal,
            onStep: s => {
              if (s.kind !== 'tool' || !s.result) return;
              if (s.result.proposed && s.result.id) proposalIds.push(s.result.id);
              if (s.result.autoConfirmed) autoFired.push({ title: s.result.title, type: s.result.type, ok: s.result.fired !== false });
              if (s.name) toolsUsed.push(s.name);
            } });
          return harden({ ok: true, specialist: spec.name, answer: r.answer, proposalIds, autoFired, toolsUsed });
        } finally { if (active === ac) active = null; }
      },
      abort: () => { try { active?.abort(); } catch { /* best effort */ } },
    };
  };
  for (const spec of specialists) { try { registerSpecialist(spec); } catch (e) { /* skip bad record */ } } // re-arm persisted specialists at boot

  // ── SCHEDULED AGENT (Project clock-icon / recurring self-improvement) ─────────
  // Run a recurring prompt as a properly ATTENUATED node: confined to `powers` (its tool
  // ring, ⊆ ALL_POWERS minus META), bound to the PROJECT's shared home folder via homeSubkey
  // (so every chat + scheduled agent in a Project read/write the same folder). Returns the
  // answer + any PROPOSALS it raised (it proposes; destructive actions still need confirm).
  const runScheduledAgent = async ({ powers = [], homeSubkey = null, prompt = '', persona: personaOverride = '', model = 'default', mode = 'recommend', signal, emit = null } = {}) => {
    // `selfImprove` (autonomous implement→verify→auto-merge) is granted ONLY to IMPLEMENT-mode tasks; every
    // legacy/recommend-mode task has it stripped exactly like a META power, so they can only propose.
    // strip META as usual, EXCEPT grant `selfImprove` to IMPLEMENT-mode tasks (the one controlled exception).
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p) && (!META_POWERS.has(p) || (p === 'selfImprove' && mode === 'implement'))))];
    const node = makeAgentNode({
      powers: granted, labelOf: `scheduled-${homeSubkey || 'global'}`,
      haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null,
      homeBinding: homeSubkey ? () => makeHome(homeSubkey) : null,
      id: `scheduled-${newSwiss()}`,
    });
    const sub = node.toolbox({ chatId: `sched-${newSwiss().slice(0, 8)}` });
    const proposalIds = []; const toolsUsed = [];
    // SOUL.md — a long-horizon agent's PERSISTENT WORKING MEMORY (CEO-Bench: refresh context each run,
    // carry only an agent-editable memory file). Each run starts fresh from SOUL.md (not a transcript),
    // does its task, and rewrites SOUL.md with what it learned + if-then contingencies for next time.
    const soulPath = homeSubkey ? `${HOME_BASE}/${homeSubkey}/SOUL.md` : null;
    let priorSoul = ''; if (soulPath) { try { priorSoul = fs.readFileSync(soulPath, 'utf8'); } catch { priorSoul = ''; } }
    const soulPreamble = soulPath
      ? `\n\n— YOUR PERSISTENT WORKING MEMORY (SOUL.md — carried across runs; this is how you remember between runs) —\n${priorSoul.trim() || '(empty — this is your first run)'}\n\nWhen you finish, END your reply with your UPDATED working memory between <SOUL> and </SOUL> markers: the durable notes you want your future self to have — key facts learned, current state, and explicit IF-THEN contingencies for next time. It REPLACES the prior SOUL, so re-state what's still true; keep it concise.`
      : '';
    const r = await AGENT_RUNNER({
      toolbox: sub.toolbox, manifest: sub.manifest, userText: String(prompt || '') + soulPreamble,
      persona: String(personaOverride || persona || ''), model, signal,
      onStep: s => {
        const detailOf = a => (a && (a.query || a.question || a.path || a.name)) || '';
        const sx = v => { try { return typeof v === 'string' ? v.slice(0, 16000) : JSON.stringify(v).slice(0, 16000); } catch { return String(v).slice(0, 2000); } };
        if (s.kind === 'tool-start') { if (emit) emit({ t: 'start', name: s.name, detail: detailOf(s.args), call: sx(s.args) }); return; }
        if (s.kind !== 'tool') return;
        // Do NOT bail on a falsy result (void/null verbs are legit) — settle the node + carry call+result
        // so the scoper's trace shows return values, not just params (matches the main-turn onStep).
        const rv = (s.result && typeof s.result === 'object') ? s.result : {};
        if (s.name) toolsUsed.push(s.name);
        if (rv.proposed && rv.id) proposalIds.push(rv.id);
        if (emit) emit({ t: 'done', name: s.name, ok: rv.ok !== false, detail: detailOf(s.args), call: sx(s.args), result: sx(s.result) });
      },
    });
    // persist the updated SOUL (harness-side, so it works regardless of the agent's tool ring) + strip
    // the marker block from the shown answer.
    let answer = r.answer || ''; let soulUpdated = false;
    if (soulPath) {
      const m = /<SOUL>([\s\S]*?)<\/SOUL>/i.exec(answer);
      if (m && m[1].trim()) { try { fs.mkdirSync(path.dirname(soulPath), { recursive: true }); fs.writeFileSync(soulPath, `${m[1].trim()}\n`); soulUpdated = true; } catch { /* best effort */ } }
      answer = answer.replace(/<SOUL>[\s\S]*?<\/SOUL>/i, '').trim();
    }
    return harden({ ok: true, answer, toolsUsed, proposalIds, grantedPowers: granted, soulUpdated });
  };

  // ── PER-CHAT SCOPED CAP (plan-then-confine) ──────────────────────────────────
  // Mint a confined cap holding EXACTLY `powers` (the user-approved subset for one chat), addressable
  // by its own swissnum. The chat then runs under this cap, so its agent is lexically confined — there
  // is no name reachable for an ungranted power. Minting is a ROOT-cap act (server-gated). Like a
  // specialist but anonymous + no persona. (Feature A: scoping agent proposes powers → user approves → mint.)
  // (re)build + register the node for a persisted scoped cap. Bindings are lazy thunks, so this is
  // safe to call at boot before/after the HA/contacts tries are built.
  const registerScoped = ({ swiss, powers, label }) => {
    const node = makeAgentNode({ powers, labelOf: `chat-${String(label || 'chat').replace(/[^\w-]/g, '_').slice(0, 32)}`, name: String(label || '').trim(), haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null, contactsBinding: () => contactsObj, id: `scoped-${String(swiss).slice(0, 8)}` });
    locator.set(swiss, { node });
    return node;
  };
  const mintScopedCap = ({ powers = [], label = '' } = {}) => {
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p)))];
    const swiss = newSwiss();
    // a DESCRIPTIVE name (no LLM round trip) so the agent reads "notes + web agent" / its given label, not the
    // bare id "scoped-a0a6c7a3": a meaningful label if provided, else a powers-derived description, else a
    // friendly pet name as the last resort.
    const labelOk = String(label || '').trim() && !/^(chat|subchat|new chat)$/i.test(String(label).trim());
    const name = labelOk ? String(label).trim().slice(0, 80) : (granted.length ? `${granted.slice(0, 3).join(' + ')} agent` : genPetName());
    registerScoped({ swiss, powers: granted, label: name });
    scopedCaps = scopedCaps.concat({ swiss, powers: granted, label: name }); saveScoped(); // survive restarts
    return harden({ ok: true, swiss, powers: granted, name, url: `${baseUrl}/#cap=${swiss}` });
  };
  // Re-scope an EXISTING chat cap to a new power set (add/revoke powers): re-register the SAME swiss
  // with the new ring + persist. The cap stays the same (the chat link doesn't change), its authority
  // changes. Returns the new ring. (Root authority — the server gates this on the root cap.)
  const rescopeCap = (swiss, powers) => {
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p)))];
    const rec = scopedCaps.find(c => c.swiss === String(swiss));
    if (!rec) return harden({ ok: false, error: 'unknown scoped cap' });
    rec.powers = granted; registerScoped({ swiss: rec.swiss, powers: granted, label: rec.label }); saveScoped();
    return harden({ ok: true, swiss: rec.swiss, powers: granted });
  };
  for (const c of scopedCaps) { try { registerScoped(c); } catch (e) { /* skip bad record */ } } // re-arm persisted scoped caps at boot

  return harden({
    runScheduledAgent,
    mintScopedCap,
    // human-visible CHANGELOG of self-applied (auto-merged) improvements + one-click revert. The server
    // gates both on the ROOT cap. revert = git revert -m 1 of the recorded merge commit (history-preserving).
    changelog: harden({
      list: ({ limit = 50 } = {}) => selfImprover.listMerges({ limit }),
      revert: ({ id } = {}) => selfImprover.rollback({ id: String(id || ''), now: new Date().toISOString() }),
    }),
    rescopeCap, // re-grant/revoke a chat cap's powers in place (same swiss) — root-gated by the server
    locator,
    rootNode,
    // register the root under its (persisted) swissnum
    registerRoot: swiss => { locator.set(swiss, { node: rootNode }); return swiss; },
    // look up the node for a swissnum (null if unknown/revoked)
    nodeFor: swiss => locator.get(String(swiss || ''))?.node || null,
    // resolve a specialist by id/name → its CONFINED node + persona, so a chat can run AS it
    // (the entrypoint-agent picker). Returns null if there's no such specialist.
    specialistFor: ref => { const spec = findSpecialist(ref); return spec ? harden({ id: spec.id, name: spec.name, node: getSpecNode(spec), persona: spec.builtin ? builtinPersona(spec.id) : (spec.instructions || ''), powers: [...spec.powers] }) : null; },
    // resolve a published-site token → its directory (for the /sites/ host)
    siteDir: token => sites.get(String(token || '')) || null,
    downloadFor,
    // Resolve an HA entity handle → a READ-ONLY entity node (or null), WITHOUT a cap. ONLY for the server's
    // component-share path: the authorization is the persisted, owner-minted, reach-verified share record
    // (the owner already proved their cap reached this handle at mint); this just reads its live state.
    haResolveReadOnly: handle => { try { const n = haTrie?.nodeByHandle(String(handle || '')); return n && n.readOnly ? n.readOnly() : (n || null); } catch { return null; } },
    // proposal lifecycle (server gates confirm/reject on the ROOT cap):
    getProposal,
    commitProposal,
    rejectProposal,
    // the agent's current (operator-confirmed) self-authored system-prompt block
    getPersona: () => persona,
    // Build the HomeAssistant object trie (async — fetches states + registries).
    // Call once at boot; entity actions register confirmable proposals.
    buildHomeAssistant: async ({ baseUrl: haUrl, token } = {}) => {
      const url = haUrl || HA_URL;
      const tok = token || fromEnv('HOMEASSISTANT');
      if (!tok) return { ok: false, error: 'no HOMEASSISTANT token (~/.env)' };
      const trie = await makeHaTrie({ baseUrl: url, token: tok, propose });
      if (!trie.configured) return { ok: false, error: trie.error };
      haTrie = trie;
      return { ok: true, rooms: trie.roomCount, entities: trie.entityCount, excluded: trie.excluded, withRegistry: trie.withRegistry };
    },
    // Build the agent-personas roster object (async — discovers via podman + ssh).
    buildAgents: async () => {
      const r = await makeAgentRoster();
      if (!r.configured) return { ok: false, error: 'no agent personas discovered' };
      agentRoster = r;
      return { ok: true, count: r.count, names: r.names };
    },
    // Build the NextCloud address book (CardDAV). Reuses the NextCloud app password
    // in the field-calendar config (same server/user); reads are free, add/edit propose.
    buildContacts: async () => {
      try {
        const cfg = JSON.parse(fs.readFileSync('/home/dan/.config/field-calendar/config.json', 'utf8'));
        const base = String(cfg.server || '').replace(/\/remote\.php.*$/, '').replace(/\/$/, '');
        if (!base || !cfg.user || !cfg.appPassword) return { ok: false, error: 'no NextCloud creds in field-calendar config' };
        contactsObj = makeContacts({ baseUrl: base, user: cfg.user, pass: cfg.appPassword, addressbook: 'contacts' });
        const count = await contactsObj.count();
        return { ok: true, count };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    // Build the admin object for dan's OWN Kazputer (the seed instance) so the agent has
    // it in inventory: searchable + actionable (settings/coins). Reads its admin cap live.
    buildKazputer: async () => {
      try {
        const dbk = JSON.parse(fs.readFileSync(KAZPUTER_STATE, 'utf8'));
        const inst = Object.values(dbk.instances || {})[0];
        if (!inst) return { ok: false, error: 'no kazputer instances' };
        const adminCap = inst.admin;
        const call = async (method, args = []) => { try { return await (await fetch(`${KAZPUTER_URL}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: adminCap, method, args }) })).json(); } catch (e) { return { ok: false, error: e.message }; } };
        kazAdmin = Far('KazputerAdmin', {
          help: () => `Admin for the "${inst.name}" Kazputer (kid-phone): settings (free play, on/off), coins, apps.`,
          describe: async () => { const d = await call('describe'); return harden(d.ok ? { kind: 'kazputer', ...d.result } : { kind: 'kazputer', error: d.error }); },
          search: async query => {
            const q = String(query || '').toLowerCase();
            const d = await call('describe'); if (!d.ok) return harden([]);
            const items = [
              { kind: 'setting', name: `Free play (${d.result.name})`, setting: 'freePlay', value: d.result.freePlay },
              { kind: 'setting', name: `Turned on (${d.result.name})`, setting: 'usable', value: d.result.usable },
              { kind: 'balance', name: `${d.result.coinName || 'Coins'} balance (${d.result.name})`, value: d.result.balance },
              ...(d.result.apps || []).map(app => ({ kind: 'app', name: app.name, id: app.id, price: app.priceCoins })),
            ];
            return harden(q ? items.filter(i => i.name.toLowerCase().includes(q)) : items);
          },
          set: async (setting, value) => call(setting === 'usable' ? 'setUsable' : 'setFreePlay', [!!value]),
          award: async n => call('award', [Number(n) || 0]),
        });
        const d = await kazAdmin.describe();
        return { ok: !d.error, name: inst.name, error: d.error };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  });
};
harden(makeFieldAgent);
