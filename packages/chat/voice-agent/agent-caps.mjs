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
import { proposeSpawn } from '../capture/agent-spawn.mjs';
import { runOpusDelegate } from './delegate.mjs';
import { runAgent } from '../../ocapn-noise/tool-bridge.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';
// Sub-agents (scheduled, specialists, employed roles) run the composable-code harness (CEO-Bench: it
// beats per-tool calls + specialized harnesses) by default. AGENT_CODEMODE=0 reverts to the classic loop.
const AGENT_RUNNER = process.env.AGENT_CODEMODE === '0' ? runAgent : runAgentCode;
import { addAsk, getSecret } from './asks-store.mjs';
import { makeConnectors } from './connectors.mjs';
import { makeCustomTools } from './custom-tools.mjs';
import { makeToolShares } from './tool-shares.mjs';
import { makeComponentGit } from './component-git.mjs';
import { buildSystemMap } from './system-map.mjs';
import { braveSearch } from './brave-search.mjs';
import { runResearch } from './research.mjs';
import { getRole, roleList, localModelFor } from './agent-roles.mjs';
import { scanArea as dietScan, evaluateArea as dietEval, buildMap as dietBuild, regenSite as dietRegen, publishSite as dietPublish, status as dietStat, DIET_SITES } from './dietician.mjs';
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
        return harden(r.ok ? { ok: true, savedTo: `/uploads/${fname}`, title: r.title, url: r.url } : r);
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
      help: () => 'Read/overwrite a vault .md note. The agent reaches this ONLY via a confirmed proposal.',
      read: async rel => { try { return fs.readFileSync(vaultWritePath(rel), 'utf8'); } catch { return ''; } },
      write: async (rel, content) => { const p = vaultWritePath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(content ?? '')); return harden({ ok: true, savedTo: p, bytes: Buffer.byteLength(String(content ?? '')) }); },
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
      exec: async (cmd, { cwd, timeoutMs = 300000 } = {}) => new Promise(resolve => {
        const full = cwd ? `cd ${JSON.stringify(String(cwd))} && ${String(cmd || '')}` : String(cmd || '');
        execFile('bash', ['-lc', full], { timeout: Math.min(Number(timeoutMs) || 300000, 600000), maxBuffer: 8 * 1024 * 1024, cwd: process.env.HOME || '/home/dan' }, (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed, stdout: String(so || '').slice(0, 40000), stderr: String(se || '').slice(0, 12000) })));
      }),
    }),
    // `delegate` is wired per-node (it needs the node's own sub-bundle builder),
    // so it is added in makeAgentNode, not here.
  });
};

// ── power metadata: name → label + the toolbox verbs it contributes ───────────
export const POWERS = harden({
  notes: { label: 'Read your personal notes', verbs: ['searchNotes', 'readNote'] },
  reference: { label: 'Consult your library + Wikipedia', verbs: ['consult'] },
  web: { label: 'Search the web (Brave) + fetch & summarize a page', verbs: ['fetchUrl', 'webSearch'] },
  research: { label: 'Employ a research team (plan → parallel search/read/distill → cited synthesis)', verbs: ['research'] },
  youtube: { label: 'Transcribe a YouTube video (fetch its captions)', verbs: ['transcribeYoutube'] },
  images: { label: 'Generate images on the GPU', verbs: ['generateImage'] },
  feed: { label: 'Post to your feed + raise/read notifications + ask typed questions (the 🔔 inbox)', verbs: ['pushFeed', 'notify', 'listNotifications', 'askOperator'] },
  contact: { label: 'Message the owner — your back-channel to reach dan (inbox + phone)', verbs: ['messageOwner'] },
  connectors: { label: 'Call connected API services (tools the owner wired up; keys injected server-side)', verbs: ['listConnectors', 'callConnector'] },
  customtools: { label: 'Use admitted library tools (agent-built, owner-reviewed; sandboxed)', verbs: ['listCustomTools', 'callCustomTool'] },
  phone: { label: 'Push a notification to your phone', verbs: ['pushPhone'] },
  timers: { label: 'Schedule wake-ups / reminders', verbs: ['scheduleWakeup', 'repeatEvery', 'cancelTimer', 'listTimers'] },
  browser: { label: 'Browse the web in a real headless browser (render JS, read pages, screenshot)', verbs: ['browseWeb', 'screenshotWeb'] },
  home: { label: 'A private home folder you can read/write and publish sites from', verbs: ['fileList', 'fileRead', 'fileWrite', 'publishSite'] },
  vm: { label: 'Full terminal in the agent-code dev VM (coarse: root over that sandbox)', verbs: ['vmExec'] },
  host: { label: '⚠️ Full shell over THIS host (archua) as the operator — the dev/dogfood harness; coarse ambient host-root, like claude-code', verbs: ['hostExec'] },
  agents: { label: 'The roster of agent personas + code sessions (read status; exec is coarse; route tasks to a dev session)', verbs: ['agentsList', 'agentStatus', 'agentExec', 'routeToDev'] },
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
});
export const ALL_POWERS = harden(Object.keys(POWERS));
harden(POWERS);

// ── build the agent. Returns the locator + a root node holding ALL powers. ────
// makeFieldAgent({ outDir, baseUrl }) →
//   { locator, register, rootNode, rootSwiss(set later), toolboxFor, manifestFor }
export const makeFieldAgent = ({ outDir, baseUrl, autoConfirmFile, specialistsFile } = {}) => {
  const aff = makeAffordances({ outDir });
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
  const sites = new Map(); // token → absolute dir
  const publish = async (dir, name) => { const token = crypto.randomBytes(8).toString('hex'); sites.set(token, dir); return { name: String(name || 'site'), url: `${baseUrl}/sites/${token}/`, token }; };
  const homeCache = new Map(); // subkey → home object (stable per agent)
  const makeHome = subkey => { if (!homeCache.has(subkey)) homeCache.set(subkey, makeHomeFolder({ root: `${HOME_BASE}/${subkey}`, label: subkey, publish })); return homeCache.get(subkey); };

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
  const NEVER_AUTO = new Set(['home-assistant', 'spawn-specialist']); // physical-world + authority-granting actions ALWAYS confirm
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
  const META_POWERS = new Set(['delegate', 'subagent', 'specialists', 'roles', 'app']); // orchestration + self-state powers — not delegable downward (sub-agents one level deep; `app` is root-only — its memo/seed/feed stores are global)
  let specialists = [];
  try { specialists = JSON.parse(fs.readFileSync(SPECIALISTS_FILE, 'utf8')).specialists || []; } catch { specialists = []; }
  const saveSpecialists = () => { try { fs.mkdirSync(path.dirname(SPECIALISTS_FILE), { recursive: true }); fs.writeFileSync(SPECIALISTS_FILE, JSON.stringify({ specialists }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };
  // Per-chat scoped caps must SURVIVE RESTARTS (else a deployed/restarted server orphans every
  // confined chat — its cap 403s, the chat silently can't send). Persist {swiss, powers, label}
  // and re-register at boot, the same durability the root swiss already has.
  const SCOPED_FILE = '/home/dan/.config/field-agent/scoped-caps.json';
  let scopedCaps = [];
  try { scopedCaps = JSON.parse(fs.readFileSync(SCOPED_FILE, 'utf8')).caps || []; } catch { scopedCaps = []; }
  const saveScoped = () => { try { fs.mkdirSync(path.dirname(SCOPED_FILE), { recursive: true }); fs.writeFileSync(SCOPED_FILE, JSON.stringify({ caps: scopedCaps }, null, 2), { mode: 0o600 }); } catch (e) { /* best effort */ } };
  const specSlug = name => `spec-${String(name || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x'}`;
  const findSpecialist = ref => { const r = String(ref || ''); return specialists.find(s => s.id === r || s.id === specSlug(r) || s.name.toLowerCase() === r.toLowerCase()); };
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
    readNote: { reversible: false, args: { path: 'string — vault-relative path' }, description: 'Read one personal note by path.',
      run: async ({ path: rel }, agent, ctx = {}) => ({ ok: true, content: String(await (ctx.notes || aff.notes).read(String(rel || ''))).slice(0, 6000) }) },
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
      run: async ({ cmd, cwd }) => aff.host.exec(String(cmd || ''), { cwd }) },
    proposeSystemPrompt: { reversible: false, args: { prompt: 'string — the new instructions block (replaces your current editable system-prompt section)' },
      description: 'PROPOSE a change to your OWN system prompt (the editable instructions block). Does NOT apply — the user confirms the diff first.',
      run: async ({ prompt }, agent) => propose({ type: 'system-prompt', power: 'selfPrompt', agent, title: 'Modify system prompt', summary: 'edit the agent\'s own instructions',
        detail: { path: '(system prompt)', mode: 'overwrite', oldContent: (persona || '(none yet)').slice(0, 12000), newContent: String(prompt || '').slice(0, 12000) },
        commit: () => writePersona(prompt) }) },
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
    // ── DIETICIAN pipeline — SSH-driven on the agent-dietician persona (the Google Places key + the
    //    proven Python tools stay there; the field agent never holds the key). Scan/evaluate/build
    //    mutate only the dietician's own DB (contained); PUBLISHING a site is OUTWARD → dietRefreshSite
    //    only PROPOSES (you confirm before anything goes live). The MAIN bot is now the intake. ──
    dietScanArea: { reversible: false, args: { city: 'string — a city slug, e.g. "berlin", "oakland", "san-francisco"' },
      description: "Scan an area's restaurants for Alexa's diet (a Google Places sweep on the dietician persona; dedupes against what's known). Returns the new candidate restaurants. Then dietEvaluateArea to judge them.",
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
    ctx = { ...ctx, timers: (node.timersBinding && node.timersBinding()) || aff.timers, notes: (node.notesBinding && node.notesBinding()) || aff.notes };
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
    if (powers.has('delegate')) {
      // delegateTask: hand the prompt to Opus with an ATTENUATED sub-bundle
      // (intersection of this node's powers and the requested powers). The
      // sub-agent's tools ARE that bundle — confinement at the delegation edge.
      // A per-run AbortController makes the delegation barge-in-cancellable:
      // runTool calls abort() when the user talks over an in-flight delegation.
      let activeDelegate = null;
      toolbox.delegateTask = harden({
        run: async ({ prompt, powers: want = [] }) => {
          const granted = new Set([...(Array.isArray(want) ? want : [])].filter(p => node.powers.has(p) && !META_POWERS.has(p)));
          // The sub-agent is its OWN node: its own (fresh) home folder + c-list,
          // inheriting this node's HA binding for any HA authority granted. So a
          // delegate asked to "build a site" gets its own home to write + publish
          // from, and only the powers passed.
          const dkey = crypto.randomBytes(3).toString('hex');
          const subNode = makeAgentNode({ powers: [...granted], labelOf: `delegate-${dkey}`, haBinding: node.haBinding, agBinding: node.agBinding, id: `delegate-${newSwiss()}` });
          const sub = subNode.toolbox(ctx); // inherit the originating chat so delegated pushes deep-link too
          const ac = new AbortController(); activeDelegate = ac;
          try {
            const r = await runOpusDelegate({ prompt: String(prompt || ''), toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: [...granted], signal: ac.signal });
            // If the delegate BUILT + proposed any tools, RETURN them to the caller as data (not
            // injected into scope). They're pending dan's review; the caller learns one was made.
            const proposedTools = customToolsObj.pendingBy(subNode.id);
            return proposedTools.length ? harden({ ...r, proposedTools }) : r;
          } finally { if (activeDelegate === ac) activeDelegate = null; }
        },
        abort: () => { try { activeDelegate?.abort(); } catch {} },
      });
      manifest.push({ name: 'delegateTask', reversible: true,
        args: { prompt: 'string — the task', powers: `array — subset of [${[...node.powers].filter(p => !META_POWERS.has(p)).join(', ')}] to grant the sub-agent` },
        description: 'Break a big task off to a larger (Opus) agent, granting it ONLY the listed powers.' });
    }
    if (powers.has('roles')) {
      // EMPLOY A ROLE — the doc's "roles are configurations, not classes." Each role
      // (agent-roles.mjs) is a tuple { tool ring, system prompt, context policy, model
      // tier, I/O contract }. The entry agent is the ORCHESTRATOR; employ() runs a role
      // in an ISOLATED context and returns ONLY its distilled result (narrow return
      // contract). Read/analysis roles → a FRESH confined sub-node (parallelizable).
      // Code/WRITE roles → the SINGLE-THREADED executor (the Blacksmith) — writes stay
      // single-threaded (the multi-agent-for-coding synthesis). Like delegateTask, an
      // in-flight employ is barge-in-cancellable.
      let activeEmploy = null;
      toolbox.employ = harden({
        run: async ({ role, task, powers: want, model } = {}) => {
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
          const subNode = makeAgentNode({ powers: [...ring], labelOf: `role-${spec.role}-${rkey}`, haBinding: node.haBinding, agBinding: node.agBinding, id: `role-${spec.role}-${newSwiss()}` });
          const sub = subNode.toolbox(ctx); // inherit the originating chat (deep-links)
          const proposalIds = []; const autoFired = []; const toolsUsed = [];
          const ac = new AbortController(); activeEmploy = ac;
          try {
            const wantOpus = model === 'opus' || model === 'strong';
            const wantLocal = model === 'gemma' || model === 'default' || model === 'local';
            // STRONG tier (or explicit "opus") → the bigger brain; falls back to gemma if no API key.
            if (wantOpus || (spec.tier === 'strong' && !wantLocal)) {
              const prompt = `${spec.prompt}\n\nTASK:\n${taskS}\n\nReturn: ${spec.output}`;
              const r = await runOpusDelegate({ prompt, toolbox: sub.toolbox, manifest: sub.manifest, grantedPowers: [...ring], signal: ac.signal });
              if (!r.error) return harden({ ok: true, role: spec.role, via: 'opus', tier: spec.tier, answer: r.answer, toolsUsed: r.toolsUsed || [], granted: [...ring] });
              // else fall through to local gemma (e.g. no ANTHROPIC_API_KEY)
            }
            const r = await AGENT_RUNNER({ toolbox: sub.toolbox, manifest: sub.manifest, userText: `TASK:\n${taskS}\n\nReturn: ${spec.output}`, persona: spec.prompt, signal: ac.signal,
              // a REAL caller model id wins; the "gemma"/"local"/"default" sentinels (wantLocal) and
              // the tier fall through to localModelFor (the role's local model, 'default' today).
              model: (model && !wantOpus && !wantLocal) ? String(model) : localModelFor(spec.tier),
              onStep: s => { if (s.kind !== 'tool' || !s.result) return; if (s.result.proposed && s.result.id) proposalIds.push(s.result.id); if (s.result.autoConfirmed) autoFired.push({ title: s.result.title, type: s.result.type, ok: s.result.fired !== false }); if (s.name) toolsUsed.push({ name: s.name }); } });
            return harden({ ok: true, role: spec.role, via: 'local', tier: spec.tier, answer: r.answer, toolsUsed: toolsUsed.length ? toolsUsed : (r.toolsUsed || []), proposalIds, autoFired, granted: [...ring] });
          } finally { if (activeEmploy === ac) activeEmploy = null; }
        },
        abort: () => { try { activeEmploy?.abort(); } catch { /* best effort */ } },
      });
      toolbox.listRoles = harden({ run: async () => ({ ok: true,
        note: 'You are the ORCHESTRATOR. employ() a role to do focused work in an ISOLATED context — only its distilled result returns to you, keeping your own context clean. COMPOSE roles for non-trivial work (e.g. planner → retriever×N → synthesizer → critic; or executor → reviewer → debugger for code). EVERY role — analysis AND dev/coder/debugger — runs IN-FRAMEWORK as a confined CodeMode sub-agent whose steps appear in the trace graph (no black-box dev session). Dev roles get a host/home dev ring; each role is granted only the intersection of its ring and YOUR powers. `tier`: "strong" → the bigger brain (Opus); "mid"/"cheap" → a local model. Pass model:"opus"/"gemma" to force.',
        roles: roleList() }) });
      manifest.push(
        { name: 'employ', reversible: true,
          args: { role: `string — one of [${roleList().map(r => r.role).join(', ')}]`, task: 'string — the focused task/question for that role', powers: 'array — OPTIONAL: narrow the role\'s tool ring to this subset', model: 'string — OPTIONAL: "opus" to force the bigger brain, "gemma" to force local, or a local model id' },
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
        return { ok: true, count: matches.length, matches };
      } });
      toolbox.haTree = harden({ run: async ({ handle } = {}) => {
        const start = handle ? node.haReach(handle) : node.haStart();
        if (!start) return { ok: false, error: handle ? 'handle not in your reach (navigate to it first)' : 'HomeAssistant not available' };
        return { ok: true, node: node.haLearn(await start.describe()) };
      } });
      toolbox.haState = harden({ run: async ({ handle }) => {
        const n = node.haReach(handle); if (!n?.state) return { ok: false, error: 'handle not in your reach, or not an entity' };
        return { ok: true, ...(await n.state()) };
      } });
      toolbox.haAct = harden({ run: async ({ handle, action, data }) => {
        const n = node.haReach(handle); if (!n) return { ok: false, error: 'handle not in your reach' };
        if (!n.act) return { ok: false, error: 'this node is read-only or not an actuable entity' };
        try { return n.act(String(action || ''), data || {}); } catch (e) { return { ok: false, error: e.message }; }
      } });
      manifest.push(
        { name: 'haFind', reversible: false, args: { query: 'string — a device name or id fragment, e.g. "hrv", "kitchen light"' }, description: 'FIND Home Assistant entities by name/id in ONE call → handles you can read/act on. PREFER this to look up a device; only use haTree to browse rooms.' },
        { name: 'haTree', reversible: false, args: { handle: 'string — optional node handle to drill into (omit to see your top level: rooms)' }, description: 'Browse the Home Assistant tree (rooms → types → entities) when exploring. To find a specific device, use haFind instead. READ is free.' },
        { name: 'haState', reversible: false, args: { handle: 'string — an entity handle from haTree' }, description: "Read an entity's live state by its handle." },
        { name: 'haAct', reversible: false, args: { handle: 'string — an entity handle from haTree', action: 'string — e.g. turn_on, turn_off, toggle, lock, unlock', data: 'object — optional service data' }, description: 'PROPOSE an action on an entity (designated by its handle). Does NOT act — the user confirms first.' },
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
        { name: 'agentExec', reversible: false, args: { handle: 'string — persona handle', cmd: 'string — shell command', cwd: 'string — optional working dir' }, description: 'Run a shell command in an agent persona (immediate; coarse authority — root over that sandbox).' },
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
      toolbox.publishSite = harden({ run: async ({ path: rel, name }) => { const h = home(); if (!h?.publishSite) return { ok: false, error: 'read-only home' }; try { return await h.publishSite(rel || '', name); } catch (e) { return { ok: false, error: e.message }; } } });
      manifest.push(
        { name: 'fileList', reversible: false, args: { path: 'string — sub-path inside your home (optional)' }, description: 'List files in your home folder.' },
        { name: 'fileRead', reversible: false, args: { path: 'string — file path inside your home' }, description: 'Read a file from your home folder.' },
        { name: 'fileWrite', reversible: false, args: { path: 'string — file path inside your home', content: 'string' }, description: 'Write a file in your home folder (creates dirs). Self-scoped — no confirmation needed.' },
        { name: 'publishSite', reversible: false, args: { path: 'string — a folder in your home holding index.html', name: 'string — a label' }, description: 'Publish a folder from your home as a static site; returns its URL.' },
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
      toolbox.listSpecialists = harden({ run: async () => ({ ok: true, specialists: specialists.map(s => ({ id: s.id, name: s.name, domain: s.domain, powers: s.powers, autonomy: listAutoRules(s.id).map(r => r.kind) })) }) });
      toolbox.proposeSpawnSpecialist = harden({ run: async ({ name, domain, powers: want = [], instructions } = {}) => {
        const granted = [...new Set((Array.isArray(want) ? want : []).filter(p => node.powers.has(p) && !META_POWERS.has(p)))];
        return np({ type: 'spawn-specialist', power: 'specialists', title: `Spawn specialist: ${String(name || 'specialist')}`, summary: `${String(domain || '')}${granted.length ? ' · ' + granted.join(', ') : ' · (no powers)'}`,
          detail: { name: String(name || ''), domain: String(domain || ''), powers: granted, instructions: String(instructions || '').slice(0, 4000) },
          commit: () => spawnSpecialist({ name, domain, powers: granted, instructions }) });
      } });
      toolbox.askSpecialist = harden(makeAskSpecialist());
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
    toolbox.shareTool = harden({ run: async ({ tool, mode, methods, ratePerMin, quota, ttlMs, priceUsd } = {}) => {
      const t = customToolsObj.list().find(x => x.name === String(tool || '') || x.id === String(tool || ''));
      if (!t) return { ok: false, error: `no admitted tool "${tool}" — only admitted library tools can be shared (see listCustomTools)` };
      const rec = toolSharesObj.create({ toolId: t.id, toolName: t.name, mode, methods, ratePerMin, quota, ttlMs, priceUsd, sharer: node.id, now: new Date().toISOString() });
      const per = rec.mode === 'factory' ? 'import' : 'use';
      const price = rec.priceUsd ? `${(rec.priceUsd / 1e6).toFixed(rec.priceUsd >= 10000 ? 2 : 6)} USD per ${per}` : 'free';
      return { ok: true, id: rec.id, mode: rec.mode, toolName: t.name, price, attenuation: rec.attenuation, note: `Shared "${t.name}" as a ${rec.mode} (${price}). Open the Shares panel to copy the link or show a QR — the link itself is intentionally NOT shown here. Revoke later with revokeToolShare({ id: "${rec.id}" }).` };
    } });
    manifest.push({ name: 'shareTool', reversible: false,
      args: { tool: 'string — an admitted tool name/id (listCustomTools)', mode: "string — 'factory' (recipient hosts their OWN instance) or 'instance' (an attenuated, metered reference to YOUR hosted instance)", methods: 'string[] — (instance) restrict to these method names; omit for all', ratePerMin: 'number — (instance) max calls per minute; omit = unlimited', quota: 'number — max total uses/imports; omit = unlimited', ttlMs: 'number — expiry in ms from now; omit = no expiry', priceUsd: 'number — µUSD charged to the consumer per use (instance) / per import (factory); omit/0 = free' },
      description: 'SHARE an admitted library component with others — as a FACTORY (they host their own instance) or an attenuated, metered, REVOCABLE INSTANCE (a reference to your hosted one). Chargeable in the usual allowance currency; payment is enforced on the consumer the standard way. The link appears only in the Shares panel, never spoken. Revoke with revokeToolShare.' });
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
    // requestAccess is ALSO always available — the escalation primitive. A confined cap CANNOT grant
    // itself powers; it ASKS the owner (dan), who approves from his inbox / the chat's powers banner.
    // This is the read-only-by-default + progressive-trust path: don't give up when you lack a power.
    toolbox.requestAccess = harden({ run: async ({ power, why } = {}) => {
      const p = String(power || '').slice(0, 40); const reason = String(why || '').slice(0, 1000);
      if (!p) return { ok: false, error: 'name the power you need' };
      if (powers.has(p)) return { ok: true, alreadyHeld: true, note: `you already hold "${p}".` };
      await aff.feed.notify({ title: `🔓 ${node.id} requests the "${p}" power`, body: reason || '(no reason given)', agent: node.id, link: chatLink(ctx) });
      try { await aff.phone.push({ title: `🔓 power request: ${p}`, message: `${node.id}: ${reason}`.slice(0, 150), click: chatLink(ctx) || '' }); } catch { /* best-effort */ }
      return { ok: true, requested: p, note: 'Asked the owner to grant this power. He approves from his inbox or the chat\'s powers banner (+ Add). You\'ll have it once he does.' };
    } });
    manifest.push({ name: 'requestAccess', reversible: false,
      args: { power: 'string — the capability you need (e.g. notes, web, images, research)', why: 'string — why you need it (helps the owner decide)' },
      description: 'REQUEST a power you do NOT currently hold from the owner. You cannot grant yourself powers — this asks the owner, who approves or declines. Use this instead of giving up when a task needs a capability you lack.' });
    // proposeTool — ALWAYS available. Build a new tool (a pure JS function of `args`) and propose it to
    // the library. It is NOT injected into anyone's scope or made callable; it queues PENDING for dan to
    // REVIEW the code, then admit. (A delegate's proposals are also RETURNED by delegateTask as data.)
    toolbox.proposeTool = harden({ run: async ({ name: tname, description, code, args, kind, files, entry } = {}) => {
      const multi = files && typeof files === 'object' && Object.keys(files).length;
      if (!multi && !String(code || '').trim()) return { ok: false, error: 'provide `code` (a `make(powers)` body) OR `files` (a multi-file class: {"tool.js": "export const make = ...", ...}). Persist via powers.state.get/set OR powers.grains (durable cells); confined (no fs/network).' };
      const r = customToolsObj.propose({ name: tname, description, code, args, kind, files, entry, proposedBy: node.id, now: new Date().toISOString() });
      await aff.feed.notify({ title: `🧩 New ${r.kind} tool proposed for review: "${r.name}"${r.multifile ? ' (multi-file)' : ''}`, body: `${String(description || '').slice(0, 200)}\n\nReview the code + admit it in the Tools panel before it becomes callable.`, agent: node.id, link: chatLink(ctx) });
      return { ok: true, proposed: true, id: r.id, name: r.name, kind: r.kind, multifile: r.multifile, note: 'Proposed for the owner\'s review. NOT callable until he reviews + admits it.' };
    } });
    manifest.push({ name: 'proposeTool', reversible: false,
      args: { name: 'string — tool name', description: 'string — what it does', kind: 'string — "instance" (one stateful object hosted here) or "class" (shareable; others instantiate locally)', code: 'string — for a single-file tool: a `make(powers)` BODY returning your tool (fn or {methods})', files: 'object — for a MULTI-FILE class: {"tool.js":"export const make = async (powers) => {…}", "helper.js":"export const …"} — the entry exports make + may import siblings', entry: 'string — entry file for files (default tool.js)', args: 'object — its arg/method schema' },
      description: 'PROPOSE a new STATEFUL tool. Pure JS (`make(powers)` → a persistent object, NOT a one-shot function). Persist via powers.state.get/set (kv) OR powers.grains — durable, mergeable, subscribable cells: `const c = powers.grains.cell("count", { merge: "sum" }); c.addContent(1); c.read()` (merges: lastWriteWins|max|min|sum|append|union). GRAINS are the component\'s DATA, kept SEPARATE from its source, so they SURVIVE a source revert/edit. Single-file → `code` (a make body). MULTI-FILE class → `files` (entry tool.js exports make + imports siblings; bundled as a real multi-module Endo SMR bundle, shareable). Queued for the owner to REVIEW + admit — never auto-injected.' });
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
      try { if (powers.has('notes')) push('notes', (await aff.notes.search(q, { limit: 5 })).map(n => ({ name: n.title, path: n.path }))); } catch { /* skip */ }
      try { if (powers.has('contacts') && contactsObj) push('contacts', await contactsObj.search(q)); } catch { /* skip */ }
      try { if (powers.has('homeassistant')) { const s = node.haStart(); if (s && s.search) push('homeassistant', await s.search(q)); } } catch { /* skip */ }
      try { if (powers.has('agents')) { const s = node.agStart(); if (s && s.search) push('agents', await s.search(q)); } } catch { /* skip */ }
      try { if (powers.has('kazputer') && kazAdmin) push('kazputer', await kazAdmin.search(q)); } catch { /* skip */ }
      return { ok: true, query: q, results: results.slice(0, 40) };
    } });
    manifest.push({ name: 'search', reversible: false, args: { query: 'string — what to find' }, description: 'Search ACROSS everything you hold in ONE call — your notes, contacts, Home Assistant, agent roster, and your Kazputer. Returns matches tagged by source. Use this to FIND something before acting; do NOT assume a thing lives in Home Assistant.' });
    return { toolbox: harden(toolbox), manifest: harden(manifest) };
  };

  // A node = a holder of a SUBSET of powers, with the right to use + re-share
  // them. The root holds ALL_POWERS. share() mints a child node (single power).
  const makeAgentNode = ({ powers, labelOf = 'agent', isRoot = false, haBinding = null, agBinding = null, contactsBinding = null, homeBinding = null, timersBinding = null, notesBinding = null, id = null }) => {
    const powerSet = new Set(powers);
    const shares = new Map(); // swiss → { power, label, createdAt, url, ha? }
    // homeBinding = () → this cap's home folder object (its own sub-dir).
    const home = homeBinding || (() => makeHome(isRoot ? 'root' : `cap-${labelOf}`.replace(/[^\w-]/g, '_').slice(0, 40)));
    const node = { powers: powerSet, isRoot, haBinding, agBinding, contactsBinding, homeBinding: home, timersBinding, notesBinding };
    // Stable agent identity for auto-confirm rules. Must be UNIQUE per cap — shares
    // pass their swissnum as `id` so two same-LABEL shares don't collide (and thus
    // can't leak one's "don't ask again" rule onto the other). Specialists pass no
    // `id`, so they keep their persisted unique slug (labelOf); root is 'root'.
    node.id = isRoot ? 'root' : (id || labelOf);

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
      listSpecialists: () => harden((node.isRoot || powerSet.has('specialists')) ? specialists.map(s => ({ id: s.id, name: s.name, domain: s.domain, powers: s.powers, autonomy: listAutoRules(s.id).map(r => r.kind) })) : []),
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
    const node = makeAgentNode({ powers: spec.powers, labelOf: spec.id, haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null });
    specNodes.set(spec.id, node);
    if (spec.swiss) locator.set(spec.swiss, { node }); // its own invite link — directly addressable
    return node;
  };
  const getSpecNode = spec => specNodes.get(spec.id) || registerSpecialist(spec);
  const spawnSpecialist = ({ name, domain, powers, instructions }) => {
    const id = specSlug(name);
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p) && !META_POWERS.has(p)))];
    const existing = specialists.find(s => s.id === id);
    const swiss = existing?.swiss || newSwiss();
    const spec = { id, name: String(name || id), domain: String(domain || ''), powers: granted, instructions: String(instructions || ''), swiss, createdAt: existing?.createdAt || new Date().toISOString() };
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
  const makeAskSpecialist = () => {
    let active = null;
    return {
      run: async ({ name, request } = {}) => {
        const spec = findSpecialist(name);
        if (!spec) return { ok: false, error: `no specialist "${name}" — list them with listSpecialists` };
        const sub = getSpecNode(spec).toolbox();
        const proposalIds = []; const autoFired = []; const toolsUsed = [];
        const ac = new AbortController(); active = ac;
        try {
          const r = await AGENT_RUNNER({ toolbox: sub.toolbox, manifest: sub.manifest, userText: String(request || ''), persona: spec.instructions, signal: ac.signal,
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
  const runScheduledAgent = async ({ powers = [], homeSubkey = null, prompt = '', persona: personaOverride = '', model = 'default', signal, emit = null } = {}) => {
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p) && !META_POWERS.has(p)))];
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
        if (s.kind === 'tool-start' && emit) emit({ t: 'start', name: s.name, detail: (s.args && (s.args.query || s.args.question || s.args.path || s.args.name)) || '' });
        if (s.kind === 'tool' && s.result) { if (s.name) toolsUsed.push(s.name); if (s.result.proposed && s.result.id) proposalIds.push(s.result.id); if (emit) emit({ t: 'done', name: s.name, ok: s.result.ok !== false }); }
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
    const node = makeAgentNode({ powers, labelOf: `chat-${String(label || 'chat').replace(/[^\w-]/g, '_').slice(0, 32)}`, haBinding: () => haTrie?.root || null, agBinding: () => agentRoster?.root || null, contactsBinding: () => contactsObj, id: `scoped-${String(swiss).slice(0, 8)}` });
    locator.set(swiss, { node });
    return node;
  };
  const mintScopedCap = ({ powers = [], label = 'chat' } = {}) => {
    const granted = [...new Set((Array.isArray(powers) ? powers : []).filter(p => ALL_POWERS.includes(p)))];
    const swiss = newSwiss();
    registerScoped({ swiss, powers: granted, label });
    scopedCaps = scopedCaps.concat({ swiss, powers: granted, label: String(label || 'chat').slice(0, 80) }); saveScoped(); // survive restarts
    return harden({ ok: true, swiss, powers: granted, url: `${baseUrl}/#cap=${swiss}` });
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
    rescopeCap, // re-grant/revoke a chat cap's powers in place (same swiss) — root-gated by the server
    locator,
    rootNode,
    // register the root under its (persisted) swissnum
    registerRoot: swiss => { locator.set(swiss, { node: rootNode }); return swiss; },
    // look up the node for a swissnum (null if unknown/revoked)
    nodeFor: swiss => locator.get(String(swiss || ''))?.node || null,
    // resolve a specialist by id/name → its CONFINED node + persona, so a chat can run AS it
    // (the entrypoint-agent picker). Returns null if there's no such specialist.
    specialistFor: ref => { const spec = findSpecialist(ref); return spec ? harden({ id: spec.id, name: spec.name, node: getSpecNode(spec), persona: spec.instructions || '', powers: [...spec.powers] }) : null; },
    // resolve a published-site token → its directory (for the /sites/ host)
    siteDir: token => sites.get(String(token || '')) || null,
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
