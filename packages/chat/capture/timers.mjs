// timers.mjs — durable timers & intervals for the agent, so it can schedule
// recurring tasks. Unlike raw setTimeout/setInterval, these survive process
// restarts: the agent registers timers into a store and the `timer-runner`
// daemon fires due ones. Actions: `notify` (push to dan) or `command` (run a
// shell command, e.g. a skill via claude -p).

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// env-overridable so tests (and a relocated personal volume) never touch the live schedule; default unchanged.
const STORE = process.env.FIELD_TIMERS_STORE || path.join(os.homedir(), '.local/state/field-timers/schedule.json');
const H = x => (typeof harden === 'function' ? harden(x) : x);
const now = () => Date.now();
const iso = ms => new Date(ms).toISOString();

const read = async () => { try { return JSON.parse(await fsp.readFile(STORE, 'utf8')); } catch { return { timers: [] }; } };
const write = async s => { s.updated = new Date().toISOString(); await fsp.mkdir(path.dirname(STORE), { recursive: true }); await fsp.writeFile(STORE, JSON.stringify(s, null, 2)); };

// plain core
// INC-2 (per-user isolation): every timer belongs to an OWNER (the non-secret per-user namespace key of the
// cap that set it; root/user-0 = 'root'). The store stays ONE file — the timer-runner daemon still reads it
// whole and fires ALL due timers regardless of owner — but list/cancel are scoped so a tenant can only see or
// cancel ITS OWN timers. A LEGACY (owner-less) record = user-0 → 'root', so personal mode is byte-identical.
export const addTimer = async ({ kind, everyMs, dueAt, action, label = '', owner = 'root' }) => {
  if (!action || !action.type) throw new Error('action {type:notify|command,...} required');
  const s = await read();
  if (!Array.isArray(s.timers)) s.timers = [];
  const id = `t-${crypto.randomBytes(4).toString('hex')}`;
  const t = { id, owner: String(owner || 'root'), kind, label, action, status: 'active', created: new Date().toISOString() };
  if (kind === 'interval') { t.everyMs = everyMs; t.nextAt = iso(now() + everyMs); }
  else { t.dueAt = dueAt; } // 'once'
  s.timers.push(t);
  await write(s);
  return { ok: true, id, fires: kind === 'interval' ? t.nextAt : t.dueAt };
};
// cancel a timer. When `owner` is given (the tenant-facing path), only a timer in THAT namespace is cancellable
// (a foreign timer is refused → { ok:false }); omit owner for the runner / internal callers (any timer).
export const cancelTimer = async (id, owner) => { const s = await read(); const t = (s.timers || []).find(x => x.id === id && (owner === undefined || (x.owner || 'root') === String(owner))); if (t) t.status = 'cancelled'; await write(s); return { ok: !!t }; };
// list timers. With an `owner` → only that namespace's (legacy/owner-less = 'root'); WITHOUT → ALL of them
// (the timer-runner daemon fires every owner's due timers; do NOT scope that path).
export const listTimers = async owner => { const all = (await read()).timers || []; return owner === undefined ? all : all.filter(t => (t.owner || 'root') === String(owner)); };

// endo object (Far loaded lazily so plain core + CLI run without SES)
export const makeTimers = async () => {
  const { Far } = await import('@endo/marshal');
  return Far('Timers', {
    help: () => H('Durable timers/intervals (survive restarts). after(ms,action), at(isoTime,action), ' +
      'every(ms,action), cancel(id), list(). action = {type:"notify",title,message,priority} or ' +
      '{type:"command",cmd}. Fired by the timer-runner daemon.'),
    after: async (ms, action, label) => H(await addTimer({ kind: 'once', dueAt: iso(now() + ms), action, label })),
    at: async (isoTime, action, label) => H(await addTimer({ kind: 'once', dueAt: isoTime, action, label })),
    every: async (ms, action, label) => H(await addTimer({ kind: 'interval', everyMs: ms, action, label })),
    cancel: async id => H(await cancelTimer(id)),
    list: async () => H(await listTimers()),
  });
};

// CLI: timers.mjs after <ms> notify "<title>" "<msg>" | every <ms> command "<cmd>" | at <iso> ... | list | cancel <id>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const parseAction = (type, a) => type === 'notify' ? { type: 'notify', title: a[0] || 'timer', message: a[1] || '', priority: a[2] || 'default' }
    : type === 'command' ? { type: 'command', cmd: a.join(' ') } : (() => { throw new Error('action: notify|command'); })();
  let out;
  if (cmd === 'list') out = await listTimers();
  else if (cmd === 'cancel') out = await cancelTimer(rest[0]);
  else if (cmd === 'after') out = await addTimer({ kind: 'once', dueAt: iso(now() + Number(rest[0])), action: parseAction(rest[1], rest.slice(2)) });
  else if (cmd === 'at') out = await addTimer({ kind: 'once', dueAt: rest[0], action: parseAction(rest[1], rest.slice(2)) });
  else if (cmd === 'every') out = await addTimer({ kind: 'interval', everyMs: Number(rest[0]), action: parseAction(rest[1], rest.slice(2)) });
  else { console.error('commands: after <ms> | at <iso> | every <ms> {notify "t" "m" | command "<cmd>"} | list | cancel <id>'); process.exit(2); }
  console.log(JSON.stringify(out));
}
