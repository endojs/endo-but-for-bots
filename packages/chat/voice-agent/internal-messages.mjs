// internal-messages.mjs — the "internal messages" chat: the agent↔Agent C back-channel for the tool pipeline
// (a sub-agent proposes a tool → the review panel's verdict → Agent C names/organizes it → admitted to the
// library). Distinct from the user-facing feed/notifications: this is the system talking to itself, surfaced
// read-only in Settings so dan can SEE what the fleet is building & how Agent C is organizing it — without a
// proposal card interrupting him for every tool. Append-only, capped, best-effort (never throws into a caller).
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/dan';
const FILE = process.env.INTERNAL_MESSAGES_FILE || `${HOME}/.local/state/field-agent/internal-messages.json`;
const CAP = 600;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).messages || []; } catch { return []; } };
const write = msgs => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ messages: msgs.slice(-CAP) }, null, 2)); } catch { /* best-effort */ } };
let seq = 0;

/** Append one internal message. entry: { from, kind, title, body, toolId, by, status } (all optional). */
export const postInternal = entry => {
  try {
    const msgs = read();
    msgs.push({ id: `im-${Date.now().toString(36)}-${(seq += 1).toString(36)}`, ts: Date.now(), from: 'agent', kind: 'note', ...(entry || {}) });
    write(msgs);
    return { ok: true };
  } catch { return { ok: false }; }
};
harden(postInternal);

/** Newest-last, capped. */
export const listInternal = ({ limit = 250 } = {}) => ({ ok: true, messages: read().slice(-limit) });
harden(listInternal);
