// asks-store.mjs — the typed-ask store behind the inline feedback loop.
//
// An "ask" is a STRUCTURED, answerable notification: instead of a free-text "would
// you like me to…", an agent raises a titled set of TYPED questions (text / choice /
// multiselect / bool / number / approve-reject — the AskUserQuestion shape). dan
// answers inline in the field-agent app with type-appropriate controls; the cycle
// completes without leaving the chat UI. Each ask carries its ORIGIN so a card can
// deep-link back (chat → #chat=<id>; off-app → an Obsidian doc).
//
// Plain Node (fs/crypto) so it is importable from BOTH the SES voice-agent server
// (server.mjs, agent-caps.mjs run under @endo/init) AND the plain-node CLI (asks.mjs)
// + the off-app drain. No @endo/init, no harden here — callers harden if needed.
//
// Lifecycle: open → answered (dan submitted) → done (off-app answer flushed to the
// input-runner drain). chat-origin asks skip 'done' (answering continues the chat).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CONFIG_DIR, DASH_STATE_DIR } from './field-config.mjs';

// Personal-family paths resolve through field-config (byte-identical defaults on the NUC;
// rebase onto FIELD_PERSONAL_ROOT when the personal volume is mounted).
export const ASKS_FILE = path.join(DASH_STATE_DIR, 'asks.json');
// secret/auth answers NEVER land in asks.json, the transcript, or the DOM-persisted
// state. They are written here, mode 0600, and only a path pointer is recorded.
export const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');

export const ASK_TYPES = ['text', 'choice', 'multiselect', 'bool', 'number', 'approve-reject', 'secret'];

// write a secret to the secure store; returns the path (the only thing recorded in asks.json)
export const storeSecret = (askId, qid, value) => {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const safe = `${String(askId).replace(/[^\w-]/g, '')}__${String(qid).replace(/[^\w-]/g, '')}`;
  const p = path.join(SECRETS_DIR, `${safe}.secret`);
  fs.writeFileSync(p, String(value ?? ''), { mode: 0o600 });
  return p;
};
// NAMED key vault — a secret with a stable name (e.g. 'brave-api-key') tools read via
// getSecret(name). This is what lets you submit an API key through the in-chat secret-ask
// flow and have the consuming tool pick it up. Env wins (NAME → UPPER_SNAKE), then the file.
const secretPath = name => path.join(SECRETS_DIR, String(name).replace(/[^\w.-]/g, '_'));
export const storeNamedSecret = (name, value) => {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const p = secretPath(name);
  fs.writeFileSync(p, String(value ?? ''), { mode: 0o600 });
  return p;
};
export const getSecret = name => {
  const n = String(name || '').trim(); if (!n) return '';
  const env = process.env[n.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()];
  if (env) return env.trim();
  try { return fs.readFileSync(secretPath(n), 'utf8').trim(); } catch { return ''; }
};

export const readAsks = () => {
  try { return JSON.parse(fs.readFileSync(ASKS_FILE, 'utf8')).asks || []; } catch { return []; }
};

export const writeAsks = asks => {
  fs.mkdirSync(path.dirname(ASKS_FILE), { recursive: true });
  const tmp = `${ASKS_FILE}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ updated: new Date().toISOString(), asks: asks.slice(0, 300) }, null, 2));
  fs.renameSync(tmp, ASKS_FILE); // atomic-ish: avoid torn reads under the concurrent writers
};

// normalize a loose question spec into {id, q, type, options?}
const normQuestion = (raw, i) => {
  const q = raw && typeof raw === 'object' ? raw : { q: String(raw || '') };
  let type = String(q.type || 'text').toLowerCase();
  if (!ASK_TYPES.includes(type)) type = 'text';
  const out = { id: String(q.id || `q${i + 1}`), q: String(q.q || q.question || '').slice(0, 600), type };
  if ((type === 'choice' || type === 'multiselect') && Array.isArray(q.options)) {
    out.options = q.options.map(o => String(o).slice(0, 200)).slice(0, 12);
  }
  if (type === 'secret' && q.key) out.key = String(q.key).replace(/[^\w.-]/g, '_').slice(0, 60); // → named key vault
  return out;
};

// create + persist an ask. origin: {kind:'chat'|'offapp'|'dev', chatId?, doc?, feedKey?, ...}
export const addAsk = ({ title, body = '', questions = [], origin = {}, requestedBy = '' } = {}) => {
  const ask = {
    id: `ask-${crypto.randomBytes(6).toString('hex')}`,
    title: String(title || 'Needs your input').slice(0, 160),
    body: String(body || '').slice(0, 1200),
    questions: (Array.isArray(questions) ? questions : []).slice(0, 10).map(normQuestion),
    origin: { kind: String(origin.kind || 'offapp'), ...origin },
    requestedBy: String(requestedBy || '').slice(0, 60),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  if (!ask.questions.length) ask.questions = [{ id: 'q1', q: ask.title, type: 'text' }];
  const asks = readAsks();
  asks.unshift(ask);
  writeAsks(asks);
  return ask;
};

export const getAsk = id => readAsks().find(a => a.id === String(id)) || null;

// record dan's typed answers; status → 'answered'. answers = { [qid]: value }.
export const answerAsk = (id, answers = {}) => {
  const asks = readAsks();
  const ask = asks.find(a => a.id === String(id));
  if (!ask) return null;
  const incoming = answers && typeof answers === 'object' ? { ...answers } : {};
  ask.secrets = [];
  // SECRET handling: divert secret-typed answers to the 0600 store; record only a
  // redacted pointer in asks.json so the plaintext never persists in the feed state.
  for (const q of ask.questions) {
    if (q.type === 'secret' && incoming[q.id]) {
      // a keyed secret goes to the NAMED vault (tools read it via getSecret(key)); an
      // unkeyed one goes to a per-ask file. Either way only a redacted pointer persists.
      try { const p = q.key ? storeNamedSecret(q.key, incoming[q.id]) : storeSecret(ask.id, q.id, incoming[q.id]); ask.secrets.push({ qid: q.id, key: q.key || null, path: p }); incoming[q.id] = q.key ? `(secret stored as ${q.key})` : '(secret stored)'; }
      catch (e) { incoming[q.id] = `(secret store failed: ${e.message})`; }
    }
  }
  ask.answers = incoming;
  for (const q of ask.questions) if (q.id in ask.answers) q.answer = ask.answers[q.id];
  ask.status = 'answered';
  ask.answeredAt = new Date().toISOString();
  writeAsks(asks);
  return ask;
};

export const setAskStatus = (id, status) => {
  const asks = readAsks();
  const ask = asks.find(a => a.id === String(id));
  if (!ask) return null;
  ask.status = status;
  writeAsks(asks);
  return ask;
};

// human-readable rendering of an ask's answers (for the off-app drain prompt / mirror)
export const formatAnswers = ask => {
  if (!ask) return '';
  const secretFor = qid => (ask.secrets || []).find(s => s.qid === qid);
  const lines = ask.questions.map(q => {
    const sec = secretFor(q.id);
    if (q.type === 'secret') return `- ${q.q}\n    → (secret provided — read it from ${sec ? sec.path : '(store)'} ; use it, never echo or log it)`;
    const a = ask.answers ? ask.answers[q.id] : undefined;
    const val = Array.isArray(a) ? a.join(', ') : (a === undefined || a === null || a === '' ? '(no answer)' : String(a));
    return `- ${q.q}\n    → ${val}`;
  });
  return lines.join('\n');
};
