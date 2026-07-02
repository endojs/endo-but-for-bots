// specialist-nudges.mjs — STANDING, scheduled nudges that wake a named SPECIALIST to do a task and report back.
//
// Specialists are already persistent + confined + referenceable across turns (spawnSpecialist/askSpecialist). What
// they lacked: a way to be put on a TIMER / EVENT-RESPONDER so they wake themselves, act, and report — so a "team"
// can actually evolve strategy between your turns. A nudge is that: the entry agent (or a specialist itself)
// schedules every(ms) / at(iso) / after(ms) against a specialist BY NAME; the server tick fires due ones, runs the
// specialist within its own confined ring, files the result as a viewable seed-chat, and pushes a deep-linked
// notification. The durable "reference" is the specialist's stable id/name (list/cancel/reschedule across turns).
//
// Store: a plain JSON file (intended at CONFIG_DIR/specialist-nudges.json, on the LUKS personal drive). NO cap is
// stored — firing runs the specialist server-side by id (it carries its own least-authority ring), so nothing here
// is a bearer secret; only ids, the request text, and the schedule.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const MIN_INTERVAL = 60_000; // never let an interval nudge run more often than once a minute (cost guard)

export const makeSpecialistNudges = ({ file, now = () => Date.now() } = {}) => {
  const read = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.nudges) ? d : { nudges: [] }; } catch { return { nudges: [] }; } };
  const write = d => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); };

  // when does an interval nudge run next? (once-nudges have no "next" — they deactivate after firing)
  const nextInterval = (schedule, from) => from + Math.max(MIN_INTERVAL, Number(schedule.everyMs) || 3_600_000);

  /**
   * Schedule a standing nudge.
   * @param {object} n
   * @param {string} n.specialistId   the specialist's stable id
   * @param {string} n.specialistName display name (for titles/notifications)
   * @param {string} [n.owner]        INC-2: the OWNER namespace the specialist lives in ('root' | 'u:<hash>').
   *   A nudge fires SERVER-SIDE (no cap in hand), so it must record which owner's namespace to resolve its
   *   specialist within — else a same-slug specialist under a DIFFERENT owner could be woken. Non-secret
   *   (already a hash); omitted on legacy nudges, which fall back to a cross-owner lookup.
   * @param {string} n.chatId         the chat the team lives in (the nudge's run links back here)
   * @param {string} n.request        what to ask the specialist each time it wakes
   * @param {object} n.schedule       { kind:'interval', everyMs } | { kind:'once', atIso } | { kind:'once', afterMs }
   * @param {string} [n.label]
   */
  const add = ({ specialistId, specialistName, owner, chatId, request, schedule, label } = {}) => {
    if (!specialistId) throw new Error('specialistId required');
    if (!schedule || !schedule.kind) throw new Error('schedule { kind:interval|once, … } required');
    const d = read();
    const base = now();
    const nextAt = schedule.kind === 'interval' ? nextInterval(schedule, base)
      : schedule.atIso ? Date.parse(schedule.atIso)
      : base + Math.max(0, Number(schedule.afterMs) || 0);
    if (!Number.isFinite(nextAt)) throw new Error('could not compute next fire time');
    const n = { id: `nudge-${crypto.randomBytes(5).toString('hex')}`, specialistId: String(specialistId), specialistName: String(specialistName || specialistId), owner: String(owner || 'root'), chatId: String(chatId || ''), request: String(request || ''), schedule, label: String(label || ''), nextAt, status: 'active', createdAt: new Date(base).toISOString(), lastRun: null, runs: 0 };
    d.nudges.unshift(n); write(d);
    return harden({ ...n });
  };

  const list = ({ specialistId } = {}) => harden(read().nudges.filter(n => !specialistId || n.specialistId === specialistId).map(n => ({ ...n })));

  // cancel by nudge id, OR all nudges for a specialist (by id or name)
  const cancel = ref => {
    const r = String(ref || ''); const d = read(); const before = d.nudges.length;
    d.nudges = d.nudges.filter(n => !(n.id === r || n.specialistId === r || n.specialistName.toLowerCase() === r.toLowerCase()));
    write(d); return { ok: before !== d.nudges.length, removed: before - d.nudges.length };
  };

  const due = (t = now()) => harden(read().nudges.filter(n => n.status === 'active' && Number.isFinite(n.nextAt) && n.nextAt <= t).map(n => ({ ...n })));

  // record a firing: reschedule an interval, deactivate a once-nudge
  const fired = id => {
    const d = read(); const n = d.nudges.find(x => x.id === id); if (!n) return;
    n.lastRun = new Date(now()).toISOString(); n.runs = (n.runs || 0) + 1;
    if (n.schedule.kind === 'interval') n.nextAt = nextInterval(n.schedule, now());
    else { n.status = 'done'; n.nextAt = null; }
    write(d);
  };

  return harden({ add, list, cancel, due, fired });
};
