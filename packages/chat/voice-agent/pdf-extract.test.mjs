// pdf-extract.test.mjs — the readPdf capability: the field agent can read a PDF document and extract its
// text, PER PAGE, from a home-folder file or a vault note path. Exercises the REAL chain
//   makeFieldAgent → toolbox.readPdf → (home.readBytes | notes.readBytes) → extractPdf → pdftotext
// with a real, hand-written 2-page PDF (no fixture file, no npm pdf dep — poppler's pdftotext is the
// extractor). Asserts: text comes back split per page in order; the joined string carries page markers;
// page/char caps truncate; the home jail and the notes-folder scope are honored (no escape); and a PDF
// read from a vault path goes through the notes authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// obsidian-graph.mjs + agent-caps.mjs read OBSIDIAN_VAULT at MODULE LOAD — point it at a throwaway vault
// BEFORE importing them (the live service likewise sets it before launch), so the vault-path test reads a
// real PDF we control instead of dan's actual vault.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-pdf-vault-'));
process.env.OBSIDIAN_VAULT = VAULT;

await import('@endo/init');
const { extractPdf } = await import('./pdf-extract.mjs');

// Build a minimal, valid multi-page PDF whose pages each show one given line of text. Deterministic and
// dependency-free — a hand-written PDF with one text object per page (pdftotext separates pages with \f).
const makePdf = lines => {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const pageObjNums = lines.map((_, i) => 3 + i * 2); // pages at 3,5,7,…
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  const fontObj = 3 + lines.length * 2; // the shared font object after all page+content objects
  lines.forEach((line, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = `BT /F1 24 Tf 72 700 Td (${line}) Tj ET`;
    objs[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  const count = fontObj;
  for (let i = 1; i <= count; i += 1) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
};

test('extractPdf splits a real multi-page PDF into per-page text, in order', async () => {
  const bytes = makePdf(['ALPHA PAGE ONE', 'BRAVO PAGE TWO', 'CHARLIE PAGE THREE']);
  const r = await extractPdf(bytes);
  assert.ok(r.ok, `extracted: ${r.error || ''}`);
  assert.equal(r.totalPages, 3);
  assert.equal(r.pages.length, 3);
  assert.deepEqual(r.pages.map(p => p.page), [1, 2, 3], 'pages numbered 1..3 in order');
  assert.match(r.pages[0].text, /ALPHA PAGE ONE/);
  assert.match(r.pages[1].text, /BRAVO PAGE TWO/);
  assert.match(r.pages[2].text, /CHARLIE PAGE THREE/);
  // page 1 text must NOT contain page 2's content — the split is exact
  assert.doesNotMatch(r.pages[0].text, /BRAVO/);
  // the joined convenience string carries page markers + every line
  assert.match(r.text, /── page 1 ──/);
  assert.match(r.text, /── page 3 ──/);
  assert.match(r.text, /CHARLIE PAGE THREE/);
});

test('extractPdf honors maxPages and reports truncation', async () => {
  const bytes = makePdf(['ONE', 'TWO', 'THREE', 'FOUR']);
  const r = await extractPdf(bytes, { maxPages: 2 });
  assert.ok(r.ok);
  assert.equal(r.renderedPages, 2, 'only 2 pages rendered');
  assert.equal(r.totalPages, 4, 'but the true page count is reported');
  assert.equal(r.truncatedPages, true);
  assert.match(r.text, /ONE/);
  assert.doesNotMatch(r.text, /THREE/);
});

test('extractPdf rejects non-PDF bytes', async () => {
  const r = await extractPdf(new Uint8Array(Buffer.from('this is plainly not a pdf', 'utf8')));
  assert.equal(r.ok, false);
  assert.match(r.error, /not a PDF/i);
});

// ── the tool, end to end through the real agent caps ──────────────────────────
test('readPdf reads a PDF from the agent home folder through the home jail', async () => {
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-pdf-home-'));
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'sp.json') });
  const { toolbox } = fa.rootNode.toolbox();

  // put a real PDF (as bytes) into the agent's own home folder, then read it back as a PDF
  const bytes = makePdf(['CONTRACT CLAUSE SEVEN', 'SIGNATURES OVERLEAF']);
  const home = fa.rootNode.homeBinding();
  // write raw bytes the way an attachment would land (the home `write` takes a string, so go direct via
  // the home root the agent is jailed to — equivalent to a file dropped in by processAttachments)
  await home.write('docs/placeholder', ''); // ensures docs/ exists in the jail
  const homeRoot = path.dirname(path.dirname(fa.downloadFor((await toolbox.createDownloadLinkFor.run({ path: 'docs/placeholder' })).token).path));
  fs.writeFileSync(path.join(homeRoot, 'docs', 'agreement.pdf'), Buffer.from(bytes));

  const r = await toolbox.readPdf.run({ homePath: 'docs/agreement.pdf' });
  assert.ok(r.ok, `read the home PDF: ${r.error || ''}`);
  assert.match(r.source, /home/);
  assert.equal(r.totalPages, 2);
  assert.match(r.pages[0].text, /CONTRACT CLAUSE SEVEN/);
  assert.match(r.pages[1].text, /SIGNATURES OVERLEAF/);

  // the home jail holds: a path that escapes the sandbox is refused (not read)
  const esc = await toolbox.readPdf.run({ homePath: '../../../../etc/hostname' });
  assert.equal(esc.ok, false, 'a path escaping the home is refused');
});

test('readPdf reads a PDF from a vault note path through the notes authority', async () => {
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  // VAULT (set before imports) is the throwaway vault the notes cap reads.
  fs.mkdirSync(path.join(VAULT, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'refs', 'spec.pdf'), Buffer.from(makePdf(['VAULT PDF PAGE A', 'VAULT PDF PAGE B'])));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-pdf-vault-out-'));
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'sp.json') });
  const { toolbox } = fa.rootNode.toolbox();

  const r = await toolbox.readPdf.run({ path: 'refs/spec.pdf' });
  assert.ok(r.ok, `read the vault PDF: ${r.error || ''}`);
  assert.match(r.source, /note/);
  assert.match(r.pages[0].text, /VAULT PDF PAGE A/);
  assert.match(r.pages[1].text, /VAULT PDF PAGE B/);

  // the vault jail holds: a path that escapes the vault is refused
  const esc = await toolbox.readPdf.run({ path: '../../../../etc/hostname' });
  assert.equal(esc.ok, false, 'a path escaping the vault is refused');
});

test('readPdf with no source argument explains what it needs', async () => {
  const { makeFieldAgent } = await import('./agent-caps.mjs');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-pdf-none-'));
  const fa = makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'ac.json'), specialistsFile: path.join(outDir, 'sp.json') });
  const { toolbox } = fa.rootNode.toolbox();
  const r = await toolbox.readPdf.run({});
  assert.equal(r.ok, false);
  assert.match(r.error, /path|homePath|url/);
});
