// projects.mjs — a PROJECT groups chats + scheduled agents and shares ONE home folder.
// This is the foundation for "recurring self-improvement from within the chat projects
// interface": a Project owns (a) the chats filed under it, (b) its scheduled-agent definitions
// (the recurring prompts + their tool ring + cadence), and (c) a single shared home subkey so
// every chat/agent in the Project reads & writes the same folder. The per-project clock-icon UI
// reads this store; the scheduled-agent runner iterates it. Pure data model — no agent execution
// here (the runner wires that), so it is unit-testable without the live harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE = process.env.PROJECTS_STORE || path.join(os.homedir(), '.local/state/voice-agent/projects.json');
const nowIso = () => new Date().toISOString();
const id = (p = 'p') => `${p}-${crypto.randomBytes(6).toString('hex')}`;

const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { projects: {}, updated: nowIso() }; } };
const save = s => { s.updated = nowIso(); fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, `${JSON.stringify(s, null, 2)}\n`); return s; };

// The shared home-folder subkey for a Project. agent-caps' makeHome(subkey) roots a home at
// HOME_BASE/<subkey>; binding every node in the project to THIS subkey = one shared folder.
export const projectHomeSubkey = projectId => `project-${projectId}`;

export const createProject = (name) => {
  const s = load();
  const pid = id('proj');
  s.projects[pid] = { id: pid, name: String(name || 'Untitled project'), chatIds: [], scheduledAgents: [], homeSubkey: projectHomeSubkey(pid), createdAt: nowIso() };
  save(s);
  return s.projects[pid];
};

export const listProjects = () => Object.values(load().projects).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
export const getProject = pid => load().projects[pid] || null;

const mutate = (pid, fn) => {
  const s = load();
  const p = s.projects[pid];
  if (!p) throw new Error(`no project ${pid}`);
  const r = fn(p);
  save(s);
  return r ?? p;
};

export const renameProject = (pid, name) => mutate(pid, p => { p.name = String(name); });
export const attachChat = (pid, chatId) => mutate(pid, p => { if (!p.chatIds.includes(chatId)) p.chatIds.push(chatId); });
export const detachChat = (pid, chatId) => mutate(pid, p => { p.chatIds = p.chatIds.filter(c => c !== chatId); });

// A scheduled agent = a prompt run with a TOOL RING (subset of powers), fired either on a CADENCE or by an
// EVENT (a propagator — fires the moment something happens, not on a clock; W4 "propagator-first").
// schedule: { kind:'interval', everyMs } | { kind:'daily', at:'HH:MM' } | { kind:'weekly', day:0-6, at:'HH:MM' }
// trigger:  { kind:'event', source:'clippings'|'inbox' }  — runs when a doc lands in that vault folder.
export const addScheduledAgent = (pid, { name, prompt, tools = [], schedule, trigger, model = 'default', mode = 'recommend', enabled = true }) => {
  if (!prompt) throw new Error('scheduled agent needs a prompt');
  if (!(schedule && schedule.kind) && !(trigger && trigger.kind)) throw new Error('a scheduled agent needs a schedule {kind,…} OR a trigger {kind:"event", source}');
  return mutate(pid, p => {
    // mode:'implement' lets the task autonomously implement→verify→(flag-gated)auto-merge (it gets the
    // selfImprove power); 'recommend' (default + every legacy task) can only propose. (dan re-vets a flip.)
    const agent = { id: id('sched'), name: String(name || 'agent'), prompt: String(prompt), tools: [...tools], schedule: (schedule && schedule.kind) ? schedule : null, trigger: (trigger && trigger.kind) ? trigger : null, model, mode: mode === 'implement' ? 'implement' : 'recommend', enabled: !!enabled, createdAt: nowIso(), lastRun: null, nextAt: null };
    p.scheduledAgents.push(agent);
    return agent;
  });
};
// every event-triggered agent across all projects subscribed to `source` (e.g. 'clippings').
export const eventAgents = source => listProjects().flatMap(p => (p.scheduledAgents || []).filter(a => a.enabled && a.trigger && a.trigger.kind === 'event' && a.trigger.source === String(source)).map(a => ({ project: p, agent: a })));
export const listScheduledAgents = pid => (getProject(pid)?.scheduledAgents) || [];
export const updateScheduledAgent = (pid, agentId, patch) => mutate(pid, p => {
  const a = p.scheduledAgents.find(x => x.id === agentId);
  if (!a) throw new Error(`no scheduled agent ${agentId}`);
  Object.assign(a, patch);
  return a;
});
export const removeScheduledAgent = (pid, agentId) => mutate(pid, p => { p.scheduledAgents = p.scheduledAgents.filter(x => x.id !== agentId); });

// which Project (if any) a chat belongs to — used by the server when building a node so the chat
// inherits its project's shared home folder.
export const projectForChat = chatId => listProjects().find(p => p.chatIds.includes(chatId)) || null;

// Next fire time for a schedule. interval {everyMs} | daily {at:'HH:MM'} | weekly {day:0-6, at}.
// (local server time; intervals floored at 60s so a bad value can't busy-loop the scheduler.)
export const computeNextAt = (schedule = {}, fromMs = Date.now()) => {
  if (schedule.kind === 'interval') return new Date(fromMs + Math.max(60000, Number(schedule.everyMs) || 3600000)).toISOString();
  const [h, m] = String(schedule.at || '02:00').split(':').map(n => Number(n) || 0);
  const next = new Date(fromMs); next.setHours(h, m, 0, 0);
  if (schedule.kind === 'weekly') {
    const day = (((Number(schedule.day) || 0) % 7) + 7) % 7;
    let delta = (day - next.getDay() + 7) % 7;
    if (delta === 0 && next.getTime() <= fromMs) delta = 7;
    next.setDate(next.getDate() + delta);
    return next.toISOString();
  }
  // daily (default)
  if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
  return next.toISOString();
};

// Mark an agent's run outcome + advance its nextAt (used by the scheduler + run-now).
export const recordAgentRun = (pid, agentId, { nextAt } = {}) => updateScheduledAgent(pid, agentId, { lastRun: nowIso(), nextAt: nextAt ?? null });
