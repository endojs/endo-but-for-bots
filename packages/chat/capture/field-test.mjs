// field-test.mjs — dogfood test ("Test like Joshua": real run, not just units).
//
// Spawns the real server.mjs (loopback only, on a throwaway port + throwaway
// inbox/state dirs so it can't touch the live vault), then drives it over HTTP:
//   1. POST /capture with a tiny synthesized audio body + CORRECT token
//      -> 200, asserts a NEW markdown note appears in the inbox & audio is saved.
//   2. POST /capture with NO token        -> 401, no note written.
//   3. POST /capture with a WRONG token   -> 401, no note written.
//   4. GET  /health (no auth)             -> 200 ok.
//   5. multipart/form-data upload + token -> 200, note written.
// Cleans up its throwaway dirs at the end. Exits non-zero on any failure.
import '@endo/init';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8779; // throwaway, distinct from the live 8770
const BASE = `http://127.0.0.1:${PORT}`;
const REAL_TOKEN = fs
  .readFileSync(path.join(os.homedir(), '.config/field-capture/token'), 'utf8')
  .trim();

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'field-capture-test-'));
// mirror the dir layout the server expects under a fake HOME
fs.mkdirSync(path.join(tmpHome, '.config/field-capture'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.local/state/field-capture/audio'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'obsidian/vault/inbox'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, '.config/field-capture/token'), REAL_TOKEN, { mode: 0o600 });

const INBOX = path.join(tmpHome, 'obsidian/vault/inbox');
const AUDIO = path.join(tmpHome, '.local/state/field-capture/audio');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${msg}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${msg}`);
  }
};

const listNotes = () => fs.readdirSync(INBOX).filter(f => f.endsWith('.md'));
const listAudio = () => fs.readdirSync(AUDIO);

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    HOME: tmpHome,
    FIELD_CAPTURE_PORT: String(PORT),
    FIELD_CAPTURE_BIND_TAILSCALE: '0', // loopback only for the test
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stdout.write(`  [srv] ${d}`));
child.stderr.on('data', d => process.stderr.write(`  [srv-err] ${d}`));

const waitHealthy = async () => {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};

const cleanup = async () => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* */
  }
  await fsp.rm(tmpHome, { recursive: true, force: true });
};

try {
  const healthy = await waitHealthy();
  ok(healthy, 'server became healthy');
  if (!healthy) throw new Error('server never came up');

  // --- GET /health (no auth) ---
  {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    ok(r.status === 200 && j.ok === true, 'GET /health -> 200 ok (no auth)');
  }

  // --- POST /capture WRONG token -> 401, no note ---
  {
    const before = listNotes().length;
    const r = await fetch(`${BASE}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', authorization: 'Bearer not-the-token' },
      body: Buffer.from('RIFFxxxxWAVE'),
    });
    const after = listNotes().length;
    ok(r.status === 401, `POST /capture wrong token -> 401 (got ${r.status})`);
    ok(after === before, 'wrong token wrote NO note');
  }

  // --- POST /capture NO token -> 401, no note ---
  {
    const before = listNotes().length;
    const r = await fetch(`${BASE}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('RIFFxxxxWAVE'),
    });
    const after = listNotes().length;
    ok(r.status === 401, `POST /capture no token -> 401 (got ${r.status})`);
    ok(after === before, 'missing token wrote NO note');
  }

  // --- POST /capture raw audio body + CORRECT token -> 200, NEW note + audio ---
  {
    const notesBefore = new Set(listNotes());
    const audioBefore = listAudio().length;
    // a tiny synthetic WAV-ish blob labeled audio/wav
    const sample = Buffer.concat([
      Buffer.from('RIFF'),
      crypto.randomBytes(64),
      Buffer.from('WAVEfmt '),
    ]);
    const r = await fetch(`${BASE}/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        authorization: `Bearer ${REAL_TOKEN}`,
        'x-filename': 'memo.wav',
        'x-hint': 'dogfood raw note',
      },
      body: sample,
    });
    const j = await r.json();
    ok(r.status === 200 && j.ok === true, `POST raw audio + token -> 200 ok (got ${r.status})`);
    const notesAfter = listNotes().filter(n => !notesBefore.has(n));
    ok(notesAfter.length === 1, `exactly ONE new note appeared (${notesAfter.length})`);
    ok(listAudio().length === audioBefore + 1, 'raw audio file saved');
    if (notesAfter.length === 1) {
      const content = fs.readFileSync(path.join(INBOX, notesAfter[0]), 'utf8');
      ok(/source: ios-voice/.test(content), 'note frontmatter has source: ios-voice');
      ok(/model: stub/.test(content), 'note records model: stub (default processor)');
      ok(/transcription pending/.test(content), 'note carries pending marker (stub)');
      ok(/audio: ".+"/.test(content), 'note references the saved audio path');
    }
    ok(typeof j.note === 'string' && j.note.endsWith('.md'), 'response.note is the .md path');
  }

  // --- POST multipart/form-data + token -> 200, new note ---
  {
    const notesBefore = new Set(listNotes());
    const form = new FormData();
    form.append('file', new Blob([crypto.randomBytes(48)], { type: 'audio/m4a' }), 'voice.m4a');
    form.append('hint', 'dogfood multipart note');
    form.append('text', 'typed alongside the audio');
    const r = await fetch(`${BASE}/capture`, {
      method: 'POST',
      headers: { authorization: `Bearer ${REAL_TOKEN}` },
      body: form,
    });
    const j = await r.json();
    ok(r.status === 200 && j.ok === true, `POST multipart + token -> 200 ok (got ${r.status})`);
    const notesAfter = listNotes().filter(n => !notesBefore.has(n));
    ok(notesAfter.length === 1, `multipart produced ONE new note (${notesAfter.length})`);
    if (notesAfter.length === 1) {
      const content = fs.readFileSync(path.join(INBOX, notesAfter[0]), 'utf8');
      ok(/typed alongside the audio/.test(content), 'multipart note includes the typed text');
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} finally {
  await cleanup();
}

process.exit(fail === 0 ? 0 : 1);
