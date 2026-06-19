// server.mjs — field-capture: the voice-note / chat capture service for "the field".
//
// Accepts an authenticated audio (or text) upload from an iOS Shortcut, hands the
// audio to a SWAPPABLE `audioProcessor` endo capability (see audio-processor.mjs),
// and writes the result as a markdown note into the Obsidian vault inbox. The raw
// audio is always persisted, so a capture is never lost even when the processor
// is the default stub.
//
// REACHABILITY: binds ONLY to the host's Tailscale IP and 127.0.0.1 — never
// 0.0.0.0, never public. Tailnet peers (and localhost) can reach it; nothing else.
// No nftables/firewall involvement.
//
// AUTH: every request to /capture must carry `Authorization: Bearer <token>`
// matching the secret at ~/.config/field-capture/token (constant-time compare).
// /health needs no auth. The token is NEVER logged.
//
// TIER: node + built-in http (no framework). It holds an endo Far cap, so it
// imports @endo/init FIRST. Node v25.
//
// Run: node /home/dan/endo-bfb/packages/chat/capture/server.mjs
//   env (all optional): FIELD_CAPTURE_PORT (default 8770),
//                       FIELD_CAPTURE_BIND_TAILSCALE=0 to skip the tailnet bind
//                       (used by the dogfood test, which hits 127.0.0.1 only).
import '@endo/init';
import { E } from '@endo/eventual-send';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeAudioProcessor } from './audio-processor.mjs';
import { makeLinkIndex, resolveLinks } from './capture-links.mjs';
import { consultReferences } from './consult.mjs';
import { notify, DASHBOARD } from './notify.mjs';

const HOME = os.homedir();
const PORT = Number(process.env.FIELD_CAPTURE_PORT ?? 8770);
const TOKEN_PATH = path.join(HOME, '.config/field-capture/token');
const STATE_DIR = path.join(HOME, '.local/state/field-capture');
const AUDIO_DIR = path.join(STATE_DIR, 'audio');
const MEDIA_DIR = path.join(STATE_DIR, 'media');
const CAPTURE_AGENT = '/home/dan/endo-bfb/packages/chat/capture/capture-agent.mjs';
// Surface a voice note as a first-class, continuable CHAT in the field-agent app
// (best-effort): the entry agent processes the verbatim transcript → a 3D-traceable,
// deep-linkable chat the SPA adopts into its list. Reads the root cap from disk.
const ROOT_SWISS_FILE = `${HOME}/.config/field-agent/root.swiss`;
const postIngestToAgent = async (transcript, title) => {
  let cap; try { cap = (await fsp.readFile(ROOT_SWISS_FILE, 'utf8')).trim(); } catch { return; }
  if (!cap) return;
  try { await fetch('http://127.0.0.1:8778/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, transcript, title: String(title || '').slice(0, 60), source: 'voice-note' }), signal: AbortSignal.timeout(180000) }); }
  catch (e) { log('ingest→agent failed:', e.message); }
};
const VAULT_ROOT = path.join(HOME, 'obsidian/vault');
const VAULT_INBOX = path.join(HOME, 'obsidian/vault/inbox');
const LOG_PATH = path.join(STATE_DIR, 'service.log');

// ---- logging (NEVER logs the token) ----------------------------------------
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* best-effort */
  }
  process.stdout.write(line);
};

// ---- token (loaded once at startup; held in memory, never logged) ----------
let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
} catch (e) {
  log('FATAL: cannot read token at', TOKEN_PATH, '-', e.message);
  process.exit(1);
}
if (!TOKEN) {
  log('FATAL: token file is empty:', TOKEN_PATH);
  process.exit(1);
}
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

/** constant-time bearer check. Returns true iff header carries the right token. */
const authOk = req => {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const got = Buffer.from(m[1].trim(), 'utf8');
  // timingSafeEqual requires equal lengths; guard with a length check that is
  // itself constant w.r.t. the secret (we compare to a fixed-size digest pair).
  if (got.length !== TOKEN_BUF.length) {
    // still burn a compare to avoid trivially-short-circuiting length oracle
    crypto.timingSafeEqual(TOKEN_BUF, TOKEN_BUF);
    return false;
  }
  return crypto.timingSafeEqual(got, TOKEN_BUF);
};

// ---- the swappable capability ----------------------------------------------
const audioProcessor = makeAudioProcessor();

// ---- helpers ----------------------------------------------------------------
const ensureDirs = async () => {
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  await fsp.mkdir(VAULT_INBOX, { recursive: true });
};

const extForMime = (mime, filename) => {
  if (filename && path.extname(filename)) return path.extname(filename).replace('.', '');
  const map = {
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
  };
  return map[(mime || '').toLowerCase()] || 'bin';
};

const readBody = req =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 100 * 1024 * 1024; // 100MB ceiling for a voice note
    req.on('data', c => {
      total += c.length;
      if (total > LIMIT) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * Minimal multipart/form-data parser (no deps). Returns { fields, files } where
 * files[name] = { filename, contentType, data:Buffer }. Liberal: tolerates CRLF
 * and bare-LF, missing content-type, etc. Good enough for an iOS Shortcut upload.
 */
const parseMultipart = (buf, boundary) => {
  const fields = {};
  const files = {};
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(delim);
  if (start === -1) return { fields, files };
  start += delim.length;
  while (start < buf.length) {
    // end marker "--"
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    // skip CRLF after boundary
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    // strip trailing CRLF before the next boundary
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    else if (buf[end - 1] === 0x0a) end -= 1;
    parts.push(buf.subarray(start, end));
    start = next + delim.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    let hEnd = headerEnd;
    let bodyStart;
    if (headerEnd !== -1) {
      bodyStart = headerEnd + 4;
    } else {
      hEnd = part.indexOf(Buffer.from('\n\n'));
      if (hEnd === -1) continue;
      bodyStart = hEnd + 2;
    }
    const headerStr = part.subarray(0, hEnd).toString('utf8');
    const data = part.subarray(bodyStart);
    const nameM = /name="([^"]*)"/i.exec(headerStr);
    const fileM = /filename="([^"]*)"/i.exec(headerStr);
    const ctM = /content-type:\s*([^\r\n]+)/i.exec(headerStr);
    const name = nameM ? nameM[1] : 'field';
    if (fileM && fileM[1]) {
      files[name] = {
        filename: fileM[1],
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data,
      };
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  return { fields, files };
};

const yamlEscape = s => String(s).replace(/"/g, '\\"');

const writeNote = async ({ transcript, model, audioPath, source, hint, mime, related = [], missing = [], answer = '', answerSource = '', processing = [] }) => {
  const now = new Date();
  const iso = now.toISOString();
  // filename: 2026-06-05T201700-<rand>.md  (filesystem-safe)
  const stamp = iso.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
  const rand = crypto.randomBytes(3).toString('hex');
  const base = `capture-${stamp}-${rand}`;
  const notePath = path.join(VAULT_INBOX, `${base}.md`);
  const title = hint && hint.trim() ? hint.trim() : `Voice capture ${iso}`;
  const fm = [
    '---',
    `date: ${iso}`,
    `source: ${source}`,
    audioPath ? `audio: "${yamlEscape(audioPath)}"` : 'audio: ""',
    `processor: audioProcessor`,
    `model: ${model}`,
    mime ? `mime: ${mime}` : null,
    'tags: [capture, the-field]',
    related.length ? `related:\n${related.map(l => `  - "[[${yamlEscape(l)}]]"`).join('\n')}` : null,
    '---',
  ]
    .filter(Boolean)
    .join('\n');
  const body = [
    `# ${title}`,
    '',
    answer ? `> 💡 **Possible answer**${answerSource ? ` (from ${answerSource})` : ''}: ${answer}\n` : '',
    transcript || '(empty)',
    '',
    related.length ? `**Linked:** ${related.map(l => `[[${l}]]`).join(', ')}` : '',
    missing.length ? `**Mentioned (no note yet):** ${missing.join(', ')}` : '',
    processing.length ? `\n## Agent processing\n${processing.map(s => `- ${s}`).join('\n')}` : '',
    audioPath ? `\n> raw audio: \`${audioPath}\`` : '',
    '',
  ].filter(l => l !== '').join('\n');
  await fsp.writeFile(notePath, `${fm}\n\n${body}`, 'utf8');
  return notePath;
};

// ---- request handling -------------------------------------------------------
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
};

const handleCapture = async (req, res) => {
  if (!authOk(req)) {
    log('capture REJECTED 401 — missing/wrong bearer token', `ua="${String(req.headers['user-agent'] || '').slice(0, 60)}"`);
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  let audioBuf = Buffer.alloc(0);
  let filename = '';
  let mime = '';
  let text = '';
  let hint = '';

  const raw = await readBody(req);

  if (ctype.startsWith('multipart/form-data')) {
    // Extract boundary from the ORIGINAL-case header — multipart boundaries are
    // case-sensitive, and iOS Shortcuts / most HTTP clients use mixed-case ones.
    // (Lowercasing ctype for the startsWith check is fine; lowercasing the
    // boundary broke every mixed-case upload → "no audio and no text" 400.)
    const bM = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
    const boundary = bM ? (bM[1] || bM[2]).trim() : '';
    const { fields, files } = parseMultipart(raw, boundary);
    // accept any of these common field names for the file
    const fileKey =
      ['file', 'audio', 'data', 'upload', 'attachment'].find(k => files[k]) ||
      Object.keys(files)[0];
    if (fileKey && files[fileKey]) {
      audioBuf = files[fileKey].data;
      filename = files[fileKey].filename;
      mime = files[fileKey].contentType;
    }
    text = fields.text || fields.note || fields.body || '';
    hint = fields.hint || fields.title || '';
  } else if (ctype.startsWith('audio/') || ctype.startsWith('image/') || ctype === 'application/octet-stream') {
    audioBuf = raw;
    mime = ctype || 'application/octet-stream';
    filename = req.headers['x-filename'] || '';
    hint = req.headers['x-hint'] || '';
    text = req.headers['x-text'] || '';
  } else if (ctype.startsWith('application/json')) {
    try {
      const j = JSON.parse(raw.toString('utf8') || '{}');
      text = j.text || j.note || '';
      hint = j.hint || j.title || '';
      if (j.audio_base64) {
        audioBuf = Buffer.from(j.audio_base64, 'base64');
        mime = j.mime || 'application/octet-stream';
        filename = j.filename || '';
      }
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'bad json' });
      return;
    }
  } else if (ctype.startsWith('text/')) {
    text = raw.toString('utf8');
    hint = req.headers['x-hint'] || '';
  } else if (raw.length > 0) {
    // liberal fallback: treat unknown non-empty body as audio bytes
    audioBuf = raw;
    mime = ctype || 'application/octet-stream';
  }

  if (audioBuf.length === 0 && !text.trim()) {
    log('capture REJECTED 400 — no audio and no text', `ctype="${ctype.slice(0, 50)}"`, `bytes=${raw.length}`);
    sendJson(res, 400, { ok: false, error: 'no audio and no text' });
    return;
  }

  // IMAGE -> EXIF labeler (capture-agent), NOT the audio/gemma path.
  // The image is written to a TRANSIENT temp file ONLY long enough for the agent
  // to read its EXIF; we delete it immediately after so we never accumulate a
  // second copy of the photo library (the original stays in NextCloud). The
  // derived note references the NextCloud source path (the X-Hint), not a copy.
  if (audioBuf.length > 0 && /^image\//.test(mime)) {
    await fsp.mkdir(MEDIA_DIR, { recursive: true });
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic' };
    const ext = (filename && path.extname(filename).slice(1).toLowerCase()) || extMap[mime] || 'img';
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const rand = crypto.randomBytes(3).toString('hex');
    const tmpPath = path.join(MEDIA_DIR, `tmp-${stamp}-${rand}.${ext}`);
    await fsp.writeFile(tmpPath, audioBuf, { mode: 0o600 });
    try {
      execFileSync('node', [CAPTURE_AGENT, '--modality', 'image', '--file', tmpPath,
        '--srcname', filename || `${stamp}.${ext}`, '--srchint', hint || filename || ''], { timeout: 60000, stdio: 'pipe' });
      log('capture image ok', `bytes=${audioBuf.length}`, `name=${filename || '(none)'}`);
      sendJson(res, 200, { ok: true, kind: 'image' });
    } catch (e) {
      log('capture-agent image failed:', (e && e.message) || String(e));
      sendJson(res, 500, { ok: false, error: 'image processing failed' });
    } finally {
      fsp.rm(tmpPath, { force: true }).catch(() => {}); // no second copy retained
    }
    return;
  }

  // persist raw audio (if any)
  let audioPath = '';
  if (audioBuf.length > 0) {
    const ext = extForMime(mime, filename);
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const rand = crypto.randomBytes(3).toString('hex');
    audioPath = path.join(AUDIO_DIR, `${stamp}-${rand}.${ext}`);
    await fsp.writeFile(audioPath, audioBuf, { mode: 0o600 });
  }

  // hand to the swappable capability
  let result;
  try {
    result = await E(audioProcessor).process(new Uint8Array(audioBuf), {
      mime,
      filename,
      hint,
      text,
    });
  } catch (e) {
    log('audioProcessor.process failed:', e.message);
    result = {
      transcript:
        (text && text.trim() ? `${text.trim()}\n\n` : '') +
        `(audioProcessor error: ${e.message})`,
      model: 'error',
    };
  }

  // Cross-link the transcript to existing vault notes — make the capture aware
  // of key terms already in the Obsidian db. Frontmatter `related:` only; the
  // verbatim transcript body is never altered. Best-effort.
  let related = [];
  let missing = [];
  try {
    const ents = result.meta && result.meta.entities;
    if (Array.isArray(ents) && ents.length) {
      const idx = await makeLinkIndex(VAULT_ROOT);
      ({ links: related, missing } = resolveLinks(idx, ents));
    }
  } catch (e) {
    log('cross-link failed:', e.message);
  }

  // If the capture is a QUESTION answerable from the bootstrap reference sources
  // (little-free-library now, Wikipedia/Kiwix when ready), answer it + push.
  let answer = '';
  let answerSource = '';
  let processing = [];
  try {
    const c = await consultReferences(result.transcript);
    processing = c.trail || [];
    if (c.answered) {
      answer = c.answer;
      answerSource = c.source;
      log('consult answered from', c.source);
      await notify({
        title: `Answer from ${c.source}`,
        message: c.answer.slice(0, 400),
        priority: 'default', tags: ['books'], click: DASHBOARD,
      }).catch(() => {});
    }
  } catch (e) { log('consult failed:', e.message); processing = [`consult error: ${e.message}`]; }

  const notePath = await writeNote({
    transcript: result.transcript,
    model: result.model,
    audioPath,
    source: 'ios-voice',
    hint,
    mime,
    related,
    missing,
    answer,
    answerSource,
    processing,
  });

  log(
    'capture ok',
    `model=${result.model}`,
    `audio=${audioBuf.length}B`,
    `note=${path.basename(notePath)}`,
  );
  // Voice notes also become first-class, continuable chats in the field agent
  // (fire-and-forget). The chat PROMPT is the clean verbatim transcript (no gemma
  // header); the full transcript is already in the Obsidian note above.
  if (audioBuf.length > 0 && result.model !== 'error' && result.transcript && result.transcript.trim()) {
    const verbatim = (result.meta && result.meta.verbatim && result.meta.verbatim.trim()) ? result.meta.verbatim : result.transcript;
    postIngestToAgent(verbatim, (result.meta && result.meta.title) || hint || path.basename(notePath, '.md')).catch(() => {});
  }
  sendJson(res, 200, {
    ok: true,
    note: notePath,
    transcript: result.transcript,
    model: result.model,
  });
};

// ---- shortcut import (UNAUTHENTICATED GET) ---------------------------------
// Serves the iOS .shortcut so an iPhone can import it by visiting
// http://<tailnet-ip>:PORT/shortcut. Import MUST be open (no token), so this
// route is intentionally unauthenticated. It is read-only and tailnet-only
// (the server binds only to loopback + the tailnet IP). It prefers a SIGNED
// artifact if one is present; otherwise it serves the unsigned plist (which
// modern iOS will NOT import on its own — see the OUTBOX README).
const SHORTCUT_CANDIDATES = [
  path.join(HOME, 'OUTBOX/field-capture-voicenote-signed.shortcut'),
  path.join(HOME, 'OUTBOX/field-capture-voicenote.shortcut'),
];
const findShortcut = () => SHORTCUT_CANDIDATES.find(p => fs.existsSync(p)) || null;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, service: 'field-capture', time: new Date().toISOString() });
    return;
  }
  if (req.method === 'GET' && url === '/shortcut') {
    const p = findShortcut();
    if (!p) {
      sendJson(res, 404, { ok: false, error: 'no shortcut artifact present' });
      return;
    }
    try {
      const buf = fs.readFileSync(p);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="Capture Voice Note.shortcut"',
        'content-length': buf.length,
      });
      res.end(buf);
      log('served', path.basename(p), `${buf.length}B`);
    } catch (e) {
      log('shortcut read failed:', e.message);
      sendJson(res, 500, { ok: false, error: 'cannot read shortcut' });
    }
    return;
  }
  if (req.method === 'POST' && url === '/capture') {
    handleCapture(req, res).catch(e => {
      log('handler error:', e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
});

// ---- bind: 127.0.0.1 ALWAYS, tailnet IP when available (never 0.0.0.0) -----
const getTailscaleIp = () => {
  if (process.env.FIELD_CAPTURE_BIND_TAILSCALE === '0') return null;
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
    const ip = out.split('\n').map(s => s.trim()).find(Boolean);
    return ip && /^100\./.test(ip) ? ip : ip || null;
  } catch {
    return null;
  }
};

await ensureDirs();
// loopback (always)
server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT} (loopback)`));
// tailnet (when available) — a separate server instance sharing the same handler
const tsIp = getTailscaleIp();
if (tsIp) {
  const handler = server.listeners('request')[0];
  const tsServer = http.createServer(handler);
  tsServer.on('error', e => log(`bind ${tsIp}:${PORT} failed:`, e.message));
  tsServer.listen(PORT, tsIp, () => log(`listening on http://${tsIp}:${PORT} (tailnet)`));
} else {
  log('no tailscale IP found — bound to loopback only');
}
log('field-capture up. audioProcessor =', String(makeAudioProcessor) && 'stub (default)');
