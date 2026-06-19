// library.mjs — read-only access to dan's little-free-library on friky, for the
// capture agent's bootstrap. No mount: reads on-demand over the existing
// dan→friky SSH (epub text via `unzip -p` server-side). Part of the growing
// "capture bootstrap" reference set.

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOST = 'root@192.168.50.74';
const ROOT = '/mnt/user/little-free-library';
const INDEX_FILE = path.join(os.homedir(), '.local/state/field-capture/library-index.json');
const INDEX_TTL_MS = 24 * 3600 * 1000;

const sshExec = (cmd, { maxBuffer = 64 * 1024 * 1024, timeout = 30000 } = {}) =>
  new Promise(res => execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, cmd],
    { maxBuffer, timeout }, (err, out, errout) => res({ err, out: out || '', errout: errout || '' })));

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Build/refresh the index of books (path + filename-derived title + ext).
export const buildLibraryIndex = async () => {
  const { out, err } = await sshExec(
    `find ${ROOT} -type f \\( -iname '*.epub' -o -iname '*.pdf' -o -iname '*.mobi' -o -iname '*.azw3' -o -iname '*.fb2' \\) -printf '%p\\n'`);
  if (err) return { ok: false, error: err.message, entries: [] };
  const entries = out.split('\n').filter(Boolean).map(p => {
    const base = p.split('/').pop().replace(/\.[^.]+$/, '');
    return { path: p, title: base, ext: (p.split('.').pop() || '').toLowerCase() };
  });
  await fsp.mkdir(path.dirname(INDEX_FILE), { recursive: true });
  await fsp.writeFile(INDEX_FILE, JSON.stringify({ built: new Date().toISOString(), count: entries.length, entries }, null, 2));
  return { ok: true, entries };
};

export const getLibraryIndex = async () => {
  try {
    const j = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8'));
    if (Date.now() - new Date(j.built).getTime() < INDEX_TTL_MS && Array.isArray(j.entries)) return j.entries;
  } catch { /* rebuild */ }
  const r = await buildLibraryIndex();
  return r.entries;
};

// Extract plain text from a book (epub only for now — pdf/mobi need extra tools).
// Streams the epub's (x)html server-side and strips tags locally. Capped.
export const extractBookText = async (bookPath, { maxChars = 600000 } = {}) => {
  const ext = (bookPath.split('.').pop() || '').toLowerCase();
  if (ext !== 'epub') return '';
  const { out } = await sshExec(
    `unzip -p ${shq(bookPath)} '*.xhtml' '*.html' '*.htm' 2>/dev/null | head -c ${maxChars * 2}`,
    { maxBuffer: maxChars * 4 });
  return out
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, maxChars);
};

// Keyword-retrieve: return the windows of text around the query's key terms.
export const retrievePassages = (text, query, { window = 1400, max = 12 } = {}) => {
  const stop = new Set(['what', 'when', 'where', 'which', 'does', 'about', 'there', 'their', 'would', 'could', 'should', 'that', 'this', 'with', 'from', 'have', 'book', 'argue', 'really', 'they', 'them', 'then', 'than', 'said', 'says']);
  const terms = [...new Set((query.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []))].filter(t => !stop.has(t));
  if (!terms.length) return text.slice(0, window * 4);
  const lower = text.toLowerCase();
  // skip the first ~4% (TOC / praise / front-matter) where keywords cluster uselessly
  const floor = Math.min(Math.floor(text.length * 0.04), 8000);
  // score windows by distinct-term density; collect hit positions
  const hits = [];
  for (const t of terms) {
    let i = lower.indexOf(t, floor);
    let c = 0;
    while (i !== -1 && c < 40) { hits.push(i); i = lower.indexOf(t, i + t.length); c += 1; }
  }
  if (!hits.length) return '';
  hits.sort((a, b) => a - b);
  const windows = [];
  for (const h of hits) {
    const start = Math.max(floor, h - window / 2);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 200) last.end = Math.max(last.end, h + window / 2);
    else windows.push({ start, end: h + window / 2 });
  }
  // rank windows by how many distinct terms they contain, keep the densest `max`
  const scored = windows.map(w => {
    const seg = lower.slice(w.start, w.end);
    const hitset = terms.filter(t => seg.includes(t)).length;
    return { ...w, score: hitset };
  }).sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.start - b.start);
  return scored.map(w => text.slice(w.start, w.end)).join('\n…\n');
};

export const LIBRARY_INFO = { host: HOST, root: ROOT, indexFile: INDEX_FILE };
