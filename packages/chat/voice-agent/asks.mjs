// asks.mjs — CLI for OFF-APP agents (Claude Code / a Blacksmith dev session) to raise
// a STRUCTURED, TYPED, answerable question that shows up in dan's field-agent app (the
// 🔔 inbox) with type-appropriate controls. dan answers inline; on "Done" the answer is
// flushed to the input-runner drain (a claude -p picks it up). A durable Obsidian mirror
// is written so the ask survives even if state is lost.
//
// Usage:
//   node asks.mjs raise --title "Ship the X?" [--body "context…"] [--requested-by claude-code] \
//        --q "Kick off the research arm?::bool" \
//        --q "Which slice first?::choice::OnShape|DoorDash|both" \
//        --q "Anything else?::text"
//   node asks.mjs list
//
// question spec:  "<text>::<type>[::opt1|opt2|…]"   type ∈ text|choice|multiselect|bool|number|approve-reject

import fs from 'node:fs';
import path from 'node:path';
import { addAsk, readAsks, ASK_TYPES } from './asks-store.mjs';

const HOME = process.env.HOME || '/home/dan';
const VAULT_ASKS_REL = 'the field/TOQU/asks.md';
const VAULT_ASKS = path.join(HOME, 'obsidian/vault', VAULT_ASKS_REL);

const parseArgs = argv => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[(i += 1)] : 'true';
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
};

const parseQuestion = s => {
  const [q, type = 'text', opts] = String(s).split('::');
  const t = ASK_TYPES.includes(type) ? type : 'text';
  const out = { q: (q || '').trim(), type: t };
  if ((t === 'choice' || t === 'multiselect') && opts) out.options = opts.split('|').map(o => o.trim()).filter(Boolean);
  if (t === 'secret' && opts) out.key = opts.trim(); // "Your Brave key::secret::brave-api-key" → named key vault
  return out;
};

const mirror = ask => {
  try {
    fs.mkdirSync(path.dirname(VAULT_ASKS), { recursive: true });
    const head = fs.existsSync(VAULT_ASKS) ? '' : '# Asks awaiting your input\n\nStructured questions raised by off-app agents. Answer them in the field-agent app (🔔 inbox); they flush to the input drain on "Done".\n';
    const qlines = ask.questions.map(q => `  - ${q.q} _(${q.type}${q.options ? ': ' + q.options.join(' / ') : ''})_`).join('\n');
    const block = `\n## ${ask.createdAt.slice(0, 10)} — ${ask.title}  \`${ask.id}\`\n` +
      (ask.body ? `${ask.body}\n` : '') +
      `Requested by: ${ask.requestedBy || 'agent'}\n${qlines}\n`;
    fs.appendFileSync(VAULT_ASKS, head + block);
  } catch (e) { process.stderr.write(`mirror failed: ${e.message}\n`); }
};

const cmd = process.argv[2];
if (cmd === 'raise') {
  const a = parseArgs(process.argv.slice(3));
  const qs = a.q ? (Array.isArray(a.q) ? a.q : [a.q]) : [];
  const questions = qs.map(parseQuestion);
  const ask = addAsk({
    title: a.title || 'Needs your input',
    body: a.body && a.body !== 'true' ? a.body : '',
    questions,
    origin: { kind: 'offapp', doc: VAULT_ASKS_REL },
    requestedBy: (a['requested-by'] && a['requested-by'] !== 'true') ? a['requested-by'] : 'claude-code',
  });
  mirror(ask);
  process.stdout.write(`${ask.id}\n`);
} else if (cmd === 'list') {
  for (const x of readAsks().filter(a => a.status !== 'done')) {
    process.stdout.write(`${x.id} [${x.status}] ${x.title} — ${x.questions.length}q (${x.origin.kind})\n`);
  }
} else {
  process.stderr.write('usage: node asks.mjs raise --title T [--body B] [--requested-by who] --q "text::type[::a|b]" … | list\n');
  process.exit(1);
}
