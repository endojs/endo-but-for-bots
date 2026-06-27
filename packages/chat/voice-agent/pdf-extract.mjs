// pdf-extract.mjs — extract text from a PDF, per page, by shelling out to
// poppler's `pdftotext` (no npm dependency: a JS PDF lib would pull a heavy tree
// under SES, and the host already ships a robust `pdftotext`).
//
// pdftotext writes a form-feed (\f) between pages, so per-page splitting is exact.
// `-f`/`-l` cap the page range at the source so we never decode a 900-page book to
// throw most of it away. The bytes are written to a private temp file (mkdtemp,
// 0700) and removed in a finally — the caller never hands us a host path, only
// bytes it already had the authority to read (notes/home jail or the web power).
//
// extractPdf(bytes, { maxPages, maxChars }) →
//   { ok: true,  pages: [{ page, text }], totalPages, truncatedPages, truncatedChars, text }
//   { ok: false, error }
import '@endo/init';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PDFTOTEXT = ['/usr/bin/pdftotext', '/usr/local/bin/pdftotext', '/bin/pdftotext'].find(p => {
  try { return fs.existsSync(p); } catch { return false; }
}) || 'pdftotext';

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_CHARS = 60000; // total, across the returned pages
const PER_PAGE_CHARS = 20000; // hard ceiling on any single page, so one giant page can't eat the whole budget

const run = (file, args, { timeoutMs = 60000 } = {}) =>
  new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, so, se) =>
      resolve({ err, so: so || '', se: se || '' }));
  });

// How many pages does the PDF have? (pdfinfo would be cleaner but isn't guaranteed;
// pdftotext -l beyond the end just stops, so we don't strictly need this. We still
// peek so the caller learns the true page count even when we cap the range.)
const pageCount = async tmpPdf => {
  // `pdftotext -l 1` then count is wrong; instead rely on the \f count of a full
  // (text-only, cheap) pass would be expensive for huge files — so try pdfinfo, else null.
  const r = await run(['/usr/bin/pdfinfo', '/usr/local/bin/pdfinfo'].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'pdfinfo', [tmpPdf]);
  if (r.err) return null;
  const m = /^Pages:\s+(\d+)/m.exec(r.so);
  return m ? Number(m[1]) : null;
};

export const extractPdf = async (bytes, { maxPages = DEFAULT_MAX_PAGES, maxChars = DEFAULT_MAX_CHARS } = {}) => {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return harden({ ok: false, error: 'no pdf bytes' });
  // Quick sniff: a PDF starts with "%PDF-" (allow a small leading BOM/whitespace window).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) return harden({ ok: false, error: 'not a PDF (missing %PDF- header)' });

  const wantPages = Math.max(1, Math.min(Number(maxPages) || DEFAULT_MAX_PAGES, 500));
  const charBudget = Math.max(1000, Math.min(Number(maxChars) || DEFAULT_MAX_CHARS, 500000));

  let dir;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdfx-'));
    const tmpPdf = path.join(dir, 'in.pdf');
    await fs.promises.writeFile(tmpPdf, bytes, { mode: 0o600 });

    const totalPages = await pageCount(tmpPdf);
    const lastPage = totalPages ? Math.min(totalPages, wantPages) : wantPages;

    // -layout keeps reading order sane for multi-column pages; -enc UTF-8 normalizes
    // output; -f 1 -l lastPage caps the range at the source. Output to stdout ("-").
    const r = await run(PDFTOTEXT, ['-q', '-layout', '-enc', 'UTF-8', '-f', '1', '-l', String(lastPage), tmpPdf, '-']);
    if (r.err) return harden({ ok: false, error: `pdftotext failed: ${String(r.se || r.err.message || '').slice(0, 300)}` });

    // pdftotext separates pages with a form-feed (\f). The output ends with a trailing
    // \f, so a split yields one extra empty tail entry — drop it.
    const raw = String(r.so).split('\f');
    if (raw.length && raw[raw.length - 1].trim() === '') raw.pop();

    const pages = [];
    let used = 0;
    let truncatedChars = false;
    for (let i = 0; i < raw.length && i < wantPages; i += 1) {
      let text = raw[i].replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > PER_PAGE_CHARS) { text = text.slice(0, PER_PAGE_CHARS); truncatedChars = true; }
      if (used + text.length > charBudget) { text = text.slice(0, Math.max(0, charBudget - used)); truncatedChars = true; }
      used += text.length;
      pages.push(harden({ page: i + 1, text }));
      if (used >= charBudget) break;
    }

    const renderedPages = pages.length;
    const effectiveTotal = totalPages || raw.length;
    const truncatedPages = effectiveTotal > renderedPages;
    // A joined convenience string with page markers, for callers that just want text.
    const joined = pages.map(p => `── page ${p.page} ──\n${p.text}`).join('\n\n');

    if (!joined.trim()) {
      return harden({ ok: true, pages, totalPages: effectiveTotal, renderedPages, truncatedPages, truncatedChars, text: '',
        note: 'No extractable text — this PDF is likely scanned images (would need OCR).' });
    }
    return harden({ ok: true, pages, totalPages: effectiveTotal, renderedPages, truncatedPages, truncatedChars, text: joined });
  } catch (e) {
    return harden({ ok: false, error: /** @type {Error} */ (e).message });
  } finally {
    if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
harden(extractPdf);
