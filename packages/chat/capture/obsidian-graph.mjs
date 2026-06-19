// obsidian-graph.mjs — an endo object representing dan's Obsidian personal-notes
// graph, for the input agent's bootstrap.
//
// CAPABILITY SHAPE (this first step, per dan):
//   • FULLY PERMITTED TO READ the personal notes.
//   • The object exposes ONLY read methods — it has NO method that sends data
//     anywhere. Communication is the caller's job, and the caller may only
//     push findings back to dan (no outside-world contact). So note content
//     can be read + reasoned over (internal gemma), but never exfiltrated.
//   • The agent's own workspace (`the field/`) is excluded — that's not
//     "personal notes", and excluding it avoids the agent answering from itself.

import { Far } from '@endo/marshal';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VAULT = path.join(os.homedir(), 'obsidian/vault');
const EXCLUDE_DIR = 'the field';
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'whats',
  'when', 'where', 'which', 'who', 'whose', 'why', 'how', 'does', 'did', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will', 'give', 'tell', 'name', 'number', 'please', 'need',
  'your', 'you', 'her', 'his', 'their', 'them', 'about', 'into', 'push', 'phone', 'get']);

const run = (cmd, args, opts = {}) =>
  new Promise(res => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 25000, ...opts },
    (err, so, se) => res({ err, so: so || '', se: se || '' })));

const terms = q => [...new Set((String(q).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []))]
  .filter(t => !STOP.has(t)).slice(0, 8);

const withinVault = rel => {
  const full = path.resolve(VAULT, rel);
  if (full !== VAULT && !full.startsWith(VAULT + path.sep)) throw new Error('path outside vault');
  return full;
};

// Plain core (also exported for non-endo callers / tests).
export const searchNotes = async (query, { limit = 8 } = {}) => {
  const ts = terms(query);
  if (!ts.length) return [];
  const args = ['-rilZ', '--include=*.md', `--exclude-dir=${EXCLUDE_DIR}`];
  for (const t of ts) { args.push('-e', t); }
  args.push(VAULT);
  const { so } = await run('grep', args);
  const files = so.split('\0').filter(Boolean).slice(0, 500);
  const scored = [];
  for (const f of files) {
    let content = '';
    try { content = (await fsp.readFile(f, 'utf8')).toLowerCase(); } catch { continue; }
    const base = path.basename(f, '.md').toLowerCase();
    const inTitle = ts.filter(t => base.includes(t)).length;
    const inBody = ts.filter(t => content.includes(t)).length;
    const score = inBody + inTitle * 2; // title matches weigh more
    if (score > 0) scored.push({ path: path.relative(VAULT, f), title: path.basename(f, '.md'), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
};
export const readNote = async rel => fsp.readFile(withinVault(rel), 'utf8');
export const noteStats = async () => {
  const { so } = await run('bash', ['-c',
    `find ${JSON.stringify(VAULT)} -name '*.md' -not -path '*/${EXCLUDE_DIR}/*' | wc -l`]);
  return { notes: Number(so.trim()) || 0, root: VAULT };
};

// The endo object.
export const makeObsidianGraph = () => Far('ObsidianGraph', {
  help: () => harden(
    "Read-only view of dan's Obsidian personal-notes graph (~17k notes). FULLY PERMITTED TO " +
    'READ; this object has no send/write methods — findings may only be communicated back to ' +
    'dan (push), never to the outside world. Methods: search(query,{limit}), read(relpath), stats().'),
  search: async (query, opts) => harden(await searchNotes(query, opts)),
  read: async rel => readNote(rel),
  stats: async () => harden(await noteStats()),
});
