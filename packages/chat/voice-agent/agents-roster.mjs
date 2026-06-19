// agents-roster.mjs — the agent personas on this machine as object capabilities.
// Each agent-* microVM (agent-code, agent-dietician, …) becomes a hardened
// Remotable in the inventory: status() is a free READ; exec() is the coarse
// terminal (root over that sandbox namespace, ssh). readOnly() attenuates (drops
// exec). Designation is the object + its web-key handle, navigated from the held
// roster — never a name re-resolved against ambient authority. (Rovie the rover
// is a separate physical grunt, already an Endo object via rover-app.)
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Far } from '@endo/marshal';

const newHandle = () => crypto.randomBytes(8).toString('hex');

// Registered Claude Code dev sessions (the Blacksmith). The field-agent-chats skill
// writes these; we surface them as roster nodes whose route() enqueues a task to the
// shared dev-queue the skill's inbox reads. Re-read fresh each call so a session that
// registers after boot shows up live (no restart).
const DEV_SESSIONS = '/home/dan/.config/field-agent/dev-sessions.json';
const DEV_QUEUE = '/home/dan/.local/state/field-agent/dev-queue.jsonl';
// BENCHED BY DEFAULT: dev sessions (the Blacksmith) are OPT-IN. routeToDev + employ's code/write roles
// resolve dev sessions via readDevs; while benched this returns [] so they refuse cleanly — nothing is
// routed to a Blacksmith. (dan benched it; stopping the runner alone left the REGISTRATION routing tasks.
// Enforce it at the source.) To un-bench deliberately: `touch ~/.config/field-agent/blacksmith-enabled`.
const BLACKSMITH_ENABLE_FLAG = '/home/dan/.config/field-agent/blacksmith-enabled';
const blacksmithEnabled = () => { try { return fs.existsSync(BLACKSMITH_ENABLE_FLAG); } catch { return false; } };
const readDevs = () => { if (!blacksmithEnabled()) return []; try { return JSON.parse(fs.readFileSync(DEV_SESSIONS, 'utf8')).sessions || []; } catch { return []; } };

// Light role hints (optional; nicer describe()). Discovery is the source of truth.
const ROLES = harden({
  'agent-code': 'software / app building (the dev VM)',
  'agent-research': 'research & reading',
  'agent-web': 'web tasks',
  'agent-writing': 'writing',
  'agent-ops': 'ops / infra',
  'agent-scratch': 'scratch / experiments',
  'agent-dietician': 'nutrition & food logging',
  'agent-personal': 'personal assistant',
  'agent-frankie': 'frankie quest persona',
  'agent-kazputer': 'kazi’s computer persona',
  'agent-muddle': 'Muddle-tree curator',
  'agent-agency': 'agency / coordination',
});

const run = (file, args, timeout = 8000) => new Promise(resolve => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, so) => resolve(err ? null : String(so || '')));
});

// Discover running agent-* personas + their agents0 IP (rootful podman → sudo -n;
// dan has NOPASSWD sudo on archua, so this works from the systemd --user service).
const discover = async () => {
  const out = await run('sudo', ['-n', 'podman', 'ps', '--format', '{{.Names}}']);
  if (!out) return [];
  const names = out.split('\n').map(s => s.trim()).filter(n => /^agent-/.test(n)).sort();
  const personas = [];
  for (const name of names) {
    const ip = (await run('sudo', ['-n', 'podman', 'inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']) || '').trim();
    if (ip) personas.push({ name, ip });
  }
  return personas;
};

const sshExec = (ip, cmd, cwd, timeoutMs = 60000) => new Promise(resolve => {
  const full = cwd ? `cd ${JSON.stringify(String(cwd))} && ${String(cmd || '')}` : String(cmd || '');
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `agent@${ip}`, '--', 'bash', '-lc', full], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, stdout: String(so || '').slice(0, 20000), stderr: String(se || '').slice(0, 8000) })));
});

// Machines inventory: hosts (not personas) that are a SHELL OVER A MACHINE — archua (this host,
// local shell), tinix (the GPU box, ssh), rovie (the rover, ssh). Config: ~/.config/field-agent/
// machines.json [{name, ssh|local, role}]. Same shell-node shape as a persona: status()=read,
// exec(cmd,{cwd})=the coarse terminal, readOnly() attenuates.
const MACHINES_FILE = '/home/dan/.config/field-agent/machines.json';
const readMachines = () => { try { const m = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8')); return Array.isArray(m) ? m : []; } catch { return []; } };
const localExec = (cmd, cwd, timeoutMs = 60000) => new Promise(resolve => {
  const full = cwd ? `cd ${JSON.stringify(String(cwd))} && ${String(cmd || '')}` : String(cmd || '');
  execFile('bash', ['-lc', full], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, stdout: String(so || '').slice(0, 20000), stderr: String(se || '').slice(0, 8000) })));
});
const sshTo = (dest, cmd, cwd, timeoutMs = 60000) => new Promise(resolve => {
  const full = cwd ? `cd ${JSON.stringify(String(cwd))} && ${String(cmd || '')}` : String(cmd || '');
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', String(dest), '--', 'bash', '-lc', full], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (err, so, se) => resolve(harden({ ok: !err, code: err?.code ?? 0, stdout: String(so || '').slice(0, 20000), stderr: String(se || '').slice(0, 8000) })));
});

// makeAgentRoster() → async → { configured, root, nodeByHandle, count, names }
export const makeAgentRoster = async () => {
  const personas = await discover();
  const machines = readMachines();
  const handles = new Map(); const memo = new Map();
  const reg = (key, node, handle) => { memo.set(key, node); handles.set(handle, node); return node; };

  const makePersona = (p, ro) => {
    const key = `agent:${p.name}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const base = {
      help: () => `Agent persona ${p.name} (${p.ip}).${ro ? ' READ-ONLY.' : ' status() is read; exec(cmd,{cwd}) is the coarse terminal.'}`,
      describe: () => harden({ kind: 'agent', handle, name: p.name, ip: p.ip, role: ROLES[p.name] || '', readOnly: !!ro }),
      status: async () => { const r = await sshExec(p.ip, 'uptime; echo PID1=$(cat /proc/1/comm 2>/dev/null)', null, 8000); return harden({ name: p.name, ip: p.ip, up: r.ok, info: r.stdout.trim() }); },
      readOnly: () => makePersona(p, true),
    };
    if (!ro) base.exec = async (cmd, opts = {}) => sshExec(p.ip, cmd, opts.cwd, opts.timeoutMs || 60000);
    return reg(key, Far(`AgentPersona(${p.name})${ro ? '·ro' : ''}`, base), handle);
  };

  // A registered code session (the Blacksmith). describe()/status() are reads;
  // route(task) enqueues a tool-build/code task to the dev-queue the skill polls.
  const makeDevSession = (s, ro) => {
    const key = `dev:${s.id}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const base = {
      help: () => `Code session "${s.name}" (${s.kind || 'claude-code'}@${s.host}).${ro ? ' READ-ONLY.' : ' route(task) hands it a tool-build/code task (host+code authority, human-supervised).'}`,
      describe: () => harden({ kind: 'dev-session', handle, name: s.name, id: s.id, host: s.host || '', role: 'code session (dev agent)', methods: s.methods || [], readOnly: !!ro }),
      status: async () => harden({ name: s.name, id: s.id, host: s.host || '', registeredAt: s.registeredAt || '', methods: s.methods || [] }),
      readOnly: () => makeDevSession(s, true),
    };
    if (!ro) base.route = async (task, meta = {}) => {
      try {
        fs.mkdirSync(path.dirname(DEV_QUEUE), { recursive: true });
        const taskId = `task-${crypto.randomBytes(5).toString('hex')}`;
        // chatId ties the task back to the originating chat so the dev's hand-off +
        // result are visible there (the dev is no longer opaque).
        fs.appendFileSync(DEV_QUEUE, `${JSON.stringify({ id: taskId, to: s.id, task: String(task || ''), status: 'pending', at: new Date().toISOString(), chatId: String(meta.chatId || '') })}\n`);
        return harden({ ok: true, taskId, to: s.id, note: `routed to ${s.name}; it picks this up in its inbox and reports back.` });
      } catch (e) { return harden({ ok: false, error: e.message }); }
    };
    return reg(key, Far(`DevSession(${s.id})${ro ? '·ro' : ''}`, base), handle);
  };
  // A MACHINE node — a shell over a host (archua=local, tinix/rovie=ssh). Same shape as a persona.
  const makeMachine = (m, ro) => {
    const key = `machine:${m.name}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const target = m.ssh || m.host || m.name;
    const exec = (cmd, opts = {}) => (m.local ? localExec(cmd, opts.cwd, opts.timeoutMs || 60000) : sshTo(target, cmd, opts.cwd, opts.timeoutMs || 60000));
    const base = {
      help: () => `Machine "${m.name}" — ${m.local ? 'this host (local shell)' : 'ssh ' + target}.${ro ? ' READ-ONLY.' : ' status() is read; exec(cmd,{cwd}) is a shell over the machine.'}`,
      describe: () => harden({ kind: 'machine', handle, name: m.name, host: m.local ? 'local' : target, role: m.role || '', readOnly: !!ro }),
      status: async () => { const r = await exec('uptime 2>/dev/null || true', { timeoutMs: 8000 }); return harden({ name: m.name, host: m.local ? 'local' : target, up: r.ok, info: ((r.stdout || '').trim() || (r.stderr || '').trim()).slice(0, 200) }); },
      readOnly: () => makeMachine(m, true),
    };
    if (!ro) base.exec = exec;
    return reg(key, Far(`Machine(${m.name})${ro ? '·ro' : ''}`, base), handle);
  };

  // personas + machines + live-read dev sessions, as one selectable list (the inventory)
  const entries = ro => [
    ...personas.map(p => { const d = makePersona(p, ro).describe(); return { name: d.name, ip: d.ip, role: d.role, handle: d.handle, kind: 'agent' }; }),
    ...machines.map(m => { const d = makeMachine(m, ro).describe(); return { name: d.name, ip: d.host, role: d.role, handle: d.handle, kind: 'machine' }; }),
    ...readDevs().map(s => { const d = makeDevSession(s, ro).describe(); return { name: d.name, ip: d.host || '', role: d.role, handle: d.handle, kind: 'dev-session' }; }),
  ];

  const makeRoster = ro => {
    const key = `roster:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const node = Far(`AgentRoster${ro ? '·ro' : ''}`, {
      help: () => `${personas.length} agent personas + registered code sessions on this machine.${ro ? ' READ-ONLY.' : ''} list()/agent(name)/readOnly().`,
      describe: () => harden({ kind: 'agent-roster', handle, readOnly: !!ro, agents: entries(ro) }),
      list: () => harden(entries(ro)),
      agent: name => { const n = String(name || ''); const p = personas.find(x => x.name === n || x.name === `agent-${n}`); if (p) return makePersona(p, ro); const mm = machines.find(x => String(x.name).toLowerCase() === n.toLowerCase()); if (mm) return makeMachine(mm, ro); const s = readDevs().find(x => x.id === n || String(x.name).toLowerCase() === n.toLowerCase()); if (s) return makeDevSession(s, ro); throw new Error(`no agent or machine "${n}"`); },
      search: query => { const q = String(query || '').toLowerCase(); return harden(entries(ro).filter(e => !q || e.name.toLowerCase().includes(q) || (e.role || '').toLowerCase().includes(q))); },
      readOnly: () => makeRoster(true),
    });
    return reg(key, node, handle);
  };

  const root = makeRoster(false);
  // resolve a registered dev (code) session to a ROUTABLE node by id/name (or the sole
  // one) — lets routeToDev hand off on the first call without an opaque c-list handle.
  const devSessions = () => readDevs();
  const devNode = ref => {
    const devs = readDevs();
    const r = String(ref || '').toLowerCase();
    let pick = r ? devs.find(s => s.id === ref || String(s.name).toLowerCase() === r) : null;
    if (!pick && (r === '' || /black|dev|smith/.test(r)) && devs.length) pick = devs[0]; // "blacksmith"/empty → the default dev session
    if (!pick && devs.length === 1) pick = devs[0];
    return pick ? makeDevSession(pick, false) : null;
  };
  return harden({ configured: personas.length > 0 || machines.length > 0 || readDevs().length > 0, root, nodeByHandle: h => handles.get(String(h || '')) || null, count: personas.length, names: personas.map(p => p.name), machines: machines.map(m => m.name), devSessions, devNode });
};
harden(makeAgentRoster);
