#!/usr/bin/env node
// capture-agent — the reactive capture processor.
//
// Fired by a per-folder watcher when a new object arrives. Activates gemma-4-31B
// as the processor, holding the "capture bootstrap" capability set:
//   - READ-ONLY to the bootstrap corpus (vault + media) for context/cross-ref,
//     INCLUDING the arrived object. It must NEVER mutate the arrived file.
//   - WRITE only to a NEW derived output note under outputRoot that REFERENCES
//     the arrived object (carries the tags/author/links/labels).
//   - Anything beyond that → ProposeCode/ProposeEndowment, written to the
//     proposals store for the operator to approve on the dashboard.
//
// Usage:
//   node capture-agent.mjs --modality clipping --file <path-to-arrived-object>
//
// Config: ./capture-bootstrap.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { makeLinkIndex, resolveLinks as resolveLinksShared } from './capture-links.mjs';
import { notify, DASHBOARD } from './notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'capture-bootstrap.json'), 'utf8'));
const VAULT = '/home/dan/obsidian/vault';
const PROPOSALS = path.join(HOME, '.local/state/field-dashboard/proposals.json');
const FEED_MJS = '/home/dan/endo-bfb/packages/chat/dashboard/feed.mjs';
const CAPTURE_LOG = path.join(HOME, 'TADA/capture-log.md');
// exiftool lands in /usr/bin/vendor_perl on Arch, which is NOT on the systemd
// --user PATH — resolve an absolute path so the service can find it.
const EXIFTOOL = ['/usr/bin/vendor_perl/exiftool', '/usr/bin/exiftool', '/usr/local/bin/exiftool']
  .find(p => fs.existsSync(p)) || 'exiftool';
const HEIFCONVERT = ['/usr/bin/heif-convert', '/usr/local/bin/heif-convert'].find(p => fs.existsSync(p)) || null;

// ---- args ------------------------------------------------------------------
const parseArgs = argv => {
  const o = {};
  for (let i = 0; i < argv.length; i += 1)
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
  return o;
};

// ---- capability enforcement -----------------------------------------------
const under = (p, root) => {
  const rp = path.resolve(p);
  const rr = path.resolve(root);
  return rp === rr || rp.startsWith(rr + path.sep);
};
// READ: must be inside a read-only root.
const assertReadable = p => {
  if (!CFG.readOnlyRoots.some(r => under(p, r)))
    throw new Error(`READ DENIED (outside bootstrap caps): ${p}`);
  return p;
};
// WRITE: must be inside outputRoot AND must not be the arrived object.
const assertWritable = (p, arrivedObject) => {
  if (!under(p, CFG.outputRoot)) throw new Error(`WRITE DENIED (outside outputRoot): ${p}`);
  if (path.resolve(p) === path.resolve(arrivedObject))
    throw new Error(`WRITE DENIED (would mutate the arrived object): ${p}`);
  return p;
};

// ---- gemma -----------------------------------------------------------------
const gemma = async (messages, maxTokens = 600) => {
  const res = await fetch(CFG.gemma.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CFG.gemma.model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`gemma ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
};
const gemmaJSON = async (messages, maxTokens) => {
  const raw = await gemma(messages, maxTokens);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`gemma returned no JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
};

// ---- FetchLink endowment: SSRF-guarded fetch + cache + summarize/describe --
const LINK_CACHE = path.join(HOME, '.local/state/field-capture/linkcache');
const isPrivateIp = ip => {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
};
const ssrfOk = async u => {
  let url; try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  try {
    const recs = await dns.lookup(url.hostname, { all: true });
    return recs.length > 0 && recs.every(r => !isPrivateIp(r.address));
  } catch { return false; }
};
const fetchGuarded = async (u, { maxBytes = 2_000_000, timeoutMs = 12000 } = {}) => {
  if (!(await ssrfOk(u))) return { ok: false, error: 'blocked/invalid url' };
  let res;
  try {
    res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'capture-agent/1.0 (+tailnet, read-only)' } });
  } catch (e) { return { ok: false, error: e.message }; }
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  if (res.url && res.url !== u && !(await ssrfOk(res.url))) return { ok: false, error: 'redirected to blocked host' };
  const ct = res.headers.get('content-type') || '';
  const chunks = []; let total = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* */ } return { ok: false, error: 'too large' }; }
      chunks.push(Buffer.from(value));
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, contentType: ct, buf: Buffer.concat(chunks), finalUrl: res.url || u };
};
const stripHtml = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const summarizeLink = async u => {
  const cf = path.join(LINK_CACHE, `${crypto.createHash('sha1').update(u).digest('hex')}.json`);
  try { return JSON.parse(await fsp.readFile(cf, 'utf8')); } catch { /* miss */ }
  const r = await fetchGuarded(u, { maxBytes: 1_500_000 });
  if (!r.ok) return { url: u, error: r.error };
  if (!/text\/html|text\/plain|application\/(xhtml|json)/.test(r.contentType)) return { url: u, error: `skipped type ${r.contentType.split(';')[0]}` };
  const html = r.buf.toString('utf8');
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = stripHtml(html).slice(0, 8000);
  let summary = '';
  try {
    summary = (await gemma([
      { role: 'system', content: 'Summarize the page in 1-2 neutral sentences. Output only the summary.' },
      { role: 'user', content: `URL: ${u}\nTitle: ${title}\n\n${text}` },
    ], 180)).trim();
  } catch (e) { summary = `(summary failed: ${e.message})`; }
  const out = { url: u, title, summary, fetchedAt: new Date().toISOString() };
  try { await fsp.mkdir(LINK_CACHE, { recursive: true }); await fsp.writeFile(cf, JSON.stringify(out, null, 2)); } catch { /* */ }
  return out;
};
const describeImage = async u => {
  const r = await fetchGuarded(u, { maxBytes: 6_000_000 });
  if (!r.ok) return { url: u, error: r.error };
  const ct = r.contentType.split(';')[0];
  if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return { url: u, error: `not a decodable image (${ct || 'unknown'})` };
  const dataUrl = `data:${ct};base64,${r.buf.toString('base64')}`;
  try {
    const desc = (await gemma([{ role: 'user', content: [
      { type: 'text', text: 'Describe this image in one concise sentence for a knowledge note.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }], 120)).trim();
    return { url: u, desc };
  } catch (e) { return { url: u, error: `vision failed: ${e.message}` }; }
};
const extractUrls = body => {
  const images = new Set(), links = new Set();
  let m;
  const imgRe = /!\[[^\]]*\]\(([^)\s]+)/g;
  while ((m = imgRe.exec(body))) if (/^https?:/.test(m[1])) images.add(m[1]);
  const linkRe = /(?<!!)\[[^\]]*\]\(([^)\s]+)/g;
  while ((m = linkRe.exec(body))) if (/^https?:/.test(m[1])) links.add(m[1]);
  const bareRe = /(?<![("<\]])\bhttps?:\/\/[^\s)<>"'\]]+/g;
  while ((m = bareRe.exec(body))) links.add(m[0].replace(/[.,;]+$/, ''));
  for (const l of [...links]) if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(l)) { images.add(l); links.delete(l); }
  for (const i of images) links.delete(i);
  return { images: [...images], links: [...links] };
};

// ---- vault link index (read-only) -----------------------------------------
// Top-level *.md basenames = the entity/topic note space for [[links]].
let LINK_INDEX = null;
const linkIndex = async () => {
  if (LINK_INDEX) return LINK_INDEX;
  assertReadable(CFG.linkIndexRoot);
  LINK_INDEX = await makeLinkIndex(CFG.linkIndexRoot);
  return LINK_INDEX;
};
// Conservative: only link entities that already exist as a note (exact, case-insensitive).
const resolveLinks = async (entities, selfBase) => resolveLinksShared(await linkIndex(), entities, selfBase);

// ---- light frontmatter field read (we compose fresh fm for the output) -----
const readField = (fm, key) => {
  // horizontal whitespace only — never let \s* cross the newline into the next field
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};

// ---- proposals store -------------------------------------------------------
const addProposals = async (proposals, ctx) => {
  if (!proposals?.length) return 0;
  await fsp.mkdir(path.dirname(PROPOSALS), { recursive: true });
  let store = { updated: '', proposals: [] };
  try { store = JSON.parse(await fsp.readFile(PROPOSALS, 'utf8')); } catch { /* fresh */ }
  if (!Array.isArray(store.proposals)) store.proposals = [];
  const now = new Date().toISOString();
  for (const p of proposals) {
    store.proposals.push({
      id: `prop-${now}-${Math.round(Math.random() * 1e6)}`,
      date: now,
      agent: 'capture-agent',
      source: ctx.source,
      kind: p.kind || 'note',
      title: p.title || '(untitled proposal)',
      body: p.body || '',
      code: p.code || '',
      endowment: p.endowment || '',
      status: 'pending',
    });
  }
  store.updated = now;
  await fsp.writeFile(PROPOSALS, JSON.stringify(store, null, 2));
  // push: an agent proposal needs the operator's input
  await notify({
    title: `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} need your review`,
    message: proposals.map(p => `• ${p.title}`).join('\n').slice(0, 300),
    priority: 'high',
    tags: ['inbox_tray'],
    click: DASHBOARD,
  }).catch(() => {});
  return proposals.length;
};

// ---- feed + log ------------------------------------------------------------
const run = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { timeout: 60000 }, (err, so, se) => res({ err, so, se }));
});
const postFeed = (opts) => {
  const a = ['post', '--title', opts.title, '--status', opts.status, '--note', opts.note, '--body', opts.body];
  for (const l of opts.links || []) a.push('--link', l);
  return run('node', [FEED_MJS, ...a]);
};
const logLine = async (line) => {
  let cur = '';
  try { cur = await fsp.readFile(CAPTURE_LOG, 'utf8'); } catch { cur = '# Capture log\n'; }
  // insert after the first "---" if present, else append
  await fsp.writeFile(CAPTURE_LOG, cur.replace(/\n---\n/, `\n---\n\n${line}\n`) === cur ? `${cur}\n${line}\n` : cur.replace(/\n---\n/, `\n---\n\n${line}\n`));
};

// ---- modality: clipping ----------------------------------------------------
const processClipping = async (file) => {
  assertReadable(file); // read-only access to the arrived object
  const text = await fsp.readFile(file, 'utf8');
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const fm = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const base = path.basename(file, '.md');
  const srcTitle = readField(fm, 'title') || base;
  const srcUrl = readField(fm, 'source');

  const sys = [
    'You are the capture agent for dan\'s knowledge vault. You enrich a newly-clipped web note',
    'so it is findable later. You NEVER rewrite the content. Return STRICT JSON only.',
  ].join(' ');
  const user = [
    `A new clipping arrived. Title: ${JSON.stringify(srcTitle)}. Source URL: ${JSON.stringify(srcUrl)}.`,
    'Content (verbatim, do not alter):',
    '"""', body.slice(0, 6000), '"""',
    '',
    'Return JSON: {',
    '  "author": string|null,            // who authored the clipped content (person/org), else null',
    '  "topics": string[],               // 3-8 topical tags, kebab-case, no # prefix',
    '  "entities": string[],             // named people/orgs/projects/concepts mentioned, for cross-linking (proper names as written)',
    '  "summary": string,                // 1-2 sentence neutral summary',
    '  "proposals": []                   // usually empty; only add {kind,title,body} if a concrete follow-up action is clearly warranted',
    '}',
    'Tips: prefer specific over generic tags. entities should be real named things, not common nouns.',
  ].join('\n');

  let enrich = { author: null, topics: [], entities: [], summary: '', proposals: [] };
  let degraded = false;
  try {
    enrich = { ...enrich, ...(await gemmaJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], 700)) };
  } catch (e) {
    degraded = true;
    console.error('[capture-agent] gemma failed, writing minimal output:', e.message);
  }

  const { links, missing } = await resolveLinks(enrich.entities, base);

  // FetchLink endowment: cache+summarize external links, describe embedded images (capped)
  const { images: imgUrls, links: extLinks } = extractUrls(body);
  const linkSummaries = [];
  for (const u of extLinks.slice(0, 6)) linkSummaries.push(await summarizeLink(u));
  const imageDescs = [];
  for (const u of imgUrls.slice(0, 3)) imageDescs.push(await describeImage(u));

  const author = enrich.author || readField(fm, 'author').replace(/\[\[|\]\]/g, '') || '';
  const tags = ['capture', 'clipping', ...(enrich.topics || [])].filter(Boolean);

  // compose the DERIVED output note (references the source; never touches it)
  const created = new Date().toISOString().slice(0, 10);
  const out = [
    '---',
    `type: capture-note`,
    `kind: clipping`,
    `source: "[[${base}]]"`,
    srcUrl ? `source_url: "${srcUrl}"` : '',
    author ? `author:\n  - "[[${author}]]"` : '',
    `created: ${created}`,
    `tags:`,
    ...tags.map(t => `  - "${t}"`),
    links.length ? `related:` : '',
    ...links.map(l => `  - "[[${l}]]"`),
    '---',
    '',
    `> Capture note for [[${base}]]${srcUrl ? ` — [source](${srcUrl})` : ''}.`,
    '',
    enrich.summary ? enrich.summary : '(no summary)',
    '',
    links.length ? `**Linked:** ${links.map(l => `[[${l}]]`).join(', ')}` : '',
    missing.length ? `**Mentioned (no note yet):** ${missing.join(', ')}` : '',
    linkSummaries.length ? '\n## Linked sources (cached)' : '',
    ...linkSummaries.map(s => s.summary
      ? `- [${s.title || s.url}](${s.url}) — ${s.summary}`
      : `- <${s.url}> — _${s.error || 'no summary'}_`),
    imageDescs.length ? '\n## Embedded images' : '',
    ...imageDescs.map(d => d.desc ? `- ${d.desc} — <${d.url}>` : `- <${d.url}> — _${d.error}_`),
    degraded ? '\n*(gemma unavailable — minimal enrichment; re-run to complete.)*' : '',
  ].filter(l => l !== '').join('\n');

  await fsp.mkdir(CFG.outputRoot, { recursive: true });
  const outPath = path.join(CFG.outputRoot, `${base} — capture.md`);
  assertWritable(outPath, file);
  await fsp.writeFile(outPath, `${out}\n`);

  const nProps = await addProposals(enrich.proposals, { source: `Clippings/${base}.md` });

  // record outcome
  const relNoExt = path.relative(VAULT, outPath).replace(/\.md$/, '');
  await postFeed({
    title: `clipping: ${srcTitle}`,
    status: degraded ? 'enriched (degraded)' : 'enriched',
    note: relNoExt,
    body: `${enrich.summary || ''} — tags: ${tags.join(', ')}${links.length ? `; linked ${links.length}` : ''}${nProps ? `; ${nProps} proposal(s)` : ''}`.slice(0, 400),
    links: [`source::Clippings/${base}.md`],
  });
  await logLine(`- **${created}** · clipping enriched · [[${base}]] → \`TADA/captures/${base} — capture\` · tags: ${tags.join(', ')}${links.length ? ` · linked: ${links.join(', ')}` : ''}${nProps ? ` · ${nProps} proposal(s)` : ''}`);

  return { outPath, tags, links, missing, proposals: nProps, degraded };
};

// ---- vision OCR (gemma): transcribe text + describe ------------------------
// Decodable formats (JPEG/PNG/WEBP/GIF) go straight to gemma vision; HEIC/HEIF
// is transcoded to JPEG via heif-convert first (gemma/vLLM can't decode HEIC).
const visionOcr = async (buf, mime) => {
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const content = [
    { type: 'text', text: 'Transcribe ALL visible text in this image verbatim (preserve line breaks). Then describe the image in one sentence. Respond as strict JSON: {"text":"<verbatim text, empty string if none>","description":"<one sentence>"}' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  try {
    const raw = await gemma([{ role: 'user', content }], 600);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); return { text: (j.text || '').trim(), description: (j.description || '').trim() }; }
    return { text: '', description: raw.trim().slice(0, 200) };
  } catch (e) { return { text: '', description: '', error: e.message }; }
};
// Returns {buf, mime} ready for gemma vision, transcoding HEIC if needed; or null.
const decodeForVision = async (file, fileType) => {
  const ft = String(fileType || '').toUpperCase();
  if (/^(JPEG|JPG|PNG|WEBP|GIF)$/.test(ft)) {
    const mime = ft === 'PNG' ? 'image/png' : ft === 'WEBP' ? 'image/webp' : ft === 'GIF' ? 'image/gif' : 'image/jpeg';
    return { buf: await fsp.readFile(file), mime };
  }
  if (/^(HEIC|HEIF)$/.test(ft)) {
    if (!HEIFCONVERT) return null;
    const tmp = `${file}.ocr.jpg`;
    const { err } = await run(HEIFCONVERT, [file, tmp]);
    try {
      const buf = await fsp.readFile(tmp);
      return { buf, mime: 'image/jpeg' };
    } catch {
      if (err) console.error('[capture-agent] heif-convert:', err.message);
      return null;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return null;
};

// ---- modality: image (EXIF + vision OCR) -----------------------------------
const kebab = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const processImage = async (file, srcname, srchint) => {
  assertReadable(file); // read-only access to the arrived object
  const { err, so } = await run(EXIFTOOL, [
    '-json', '-dateFormat', '%Y-%m-%dT%H:%M:%S',
    '-DateTimeOriginal', '-CreateDate', '-GPSLatitude#', '-GPSLongitude#',
    '-Make', '-Model', '-LensModel', '-ImageSize', '-MIMEType', '-FileType', '-Orientation',
    file,
  ]);
  let ex = {};
  try { ex = (JSON.parse(so || '[]')[0]) || {}; } catch { /* none */ }
  if (err && !Object.keys(ex).length) console.error('[capture-agent] exiftool:', err.message);

  const origName = srcname || path.basename(file);
  const base = path.basename(origName, path.extname(origName));
  const captured = ex.DateTimeOriginal || ex.CreateDate || '';
  const day = captured ? String(captured).slice(0, 10) : '';
  const year = day ? day.slice(0, 4) : '';
  const lat = ex.GPSLatitude;
  const lon = ex.GPSLongitude;
  const hasGps = lat !== undefined && lon !== undefined;
  const camera = [ex.Make, ex.Model].filter(Boolean).join(' ').trim();

  // vision OCR: transcribe text + describe (HEIC transcoded first)
  const vis = await decodeForVision(file, ex.FileType);
  const ocr = vis ? await visionOcr(vis.buf, vis.mime) : null;

  const tags = [
    'capture', 'photo',
    year ? `year-${year}` : '',
    camera ? `cam-${kebab(camera)}` : '',
    hasGps ? 'geotagged' : '',
    ocr && ocr.text ? 'has-text' : '',
    ex.FileType ? kebab(ex.FileType) : '',
  ].filter(Boolean);

  const created = new Date().toISOString().slice(0, 10);
  const geo = hasGps ? `${lat},${lon}` : '';
  const out = [
    '---',
    'type: capture-note',
    'kind: photo',
    `source_file: "${srchint || origName}"`,
    captured ? `captured: "${captured}"` : '',
    hasGps ? `gps: "${geo}"` : '',
    camera ? `camera: "${camera}"` : '',
    ex.ImageSize ? `dimensions: "${ex.ImageSize}"` : '',
    `created: ${created}`,
    'tags:',
    ...tags.map(t => `  - "${t}"`),
    '---',
    '',
    `> Capture note for photo \`${origName}\`.`,
    '',
    [
      captured ? `Captured **${captured}**` : 'No capture timestamp',
      camera ? `with **${camera}**` : '',
      hasGps ? `at **${geo}** ([map](https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}))` : '(no GPS)',
      ex.ImageSize ? `· ${ex.ImageSize}` : '',
    ].filter(Boolean).join(' ') + '.',
    '',
    ocr && ocr.description ? `**Vision:** ${ocr.description}` : '',
    ocr && ocr.text ? `\n## Text in image\n\`\`\`\n${ocr.text}\n\`\`\`` : '',
    `\n*Labeled from EXIF${ocr ? ' + gemma vision OCR' : ''}.*`,
  ].filter(l => l !== '').join('\n');

  await fsp.mkdir(CFG.outputRoot, { recursive: true });
  const outPath = path.join(CFG.outputRoot, `${base} — photo.md`);
  assertWritable(outPath, file);
  await fsp.writeFile(outPath, `${out}\n`);

  const relNoExt = path.relative(VAULT, outPath).replace(/\.md$/, '');
  await postFeed({
    title: `photo: ${origName}`,
    status: ocr ? (ocr.text ? 'labeled (EXIF + OCR text)' : 'labeled (EXIF + vision)') : 'labeled (EXIF)',
    note: relNoExt,
    body: `${day ? day + ' ' : ''}${camera || ''}${hasGps ? ' · geotagged' : ''}${ocr && ocr.text ? ` · text: "${ocr.text.replace(/\s+/g, ' ').slice(0, 80)}"` : ''} — tags: ${tags.join(', ')}`.slice(0, 400),
    links: [],
  });
  await logLine(`- **${created}** · photo labeled · \`${origName}\` → \`TADA/captures/${base} — photo\` · ${day || 'no-date'}${hasGps ? ' · geotagged' : ''}${camera ? ' · ' + camera : ''}`);
  return { outPath, tags, captured, gps: geo, camera };
};

// ---- main ------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (!args.file || !args.modality) {
  console.error('usage: capture-agent.mjs --modality <clipping|image|voice> --file <path>');
  process.exit(2);
}
const file = path.resolve(args.file);
try {
  await fsp.access(file, fs.constants.R_OK);
} catch {
  console.error(`[capture-agent] file not readable: ${file}`);
  process.exit(1);
}

let result;
if (args.modality === 'clipping') result = await processClipping(file);
else if (args.modality === 'image') result = await processImage(file, args.srcname, args.srchint);
else {
  console.error(`[capture-agent] modality not implemented yet: ${args.modality}`);
  process.exit(2);
}
console.log(`[capture-agent] ${args.modality} done → ${result.outPath}`);
process.exit(0);
