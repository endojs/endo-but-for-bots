// youtube.mjs — fetch a YouTube video's transcript (captions) via yt-dlp, as a
// READ-ONLY field-agent capability (the agent's version of the youtube-transcript
// skill). Bounded to YouTube hosts so the agent can't drive yt-dlp's many other
// extractors at arbitrary/internal URLs. Returns the title + dedup'd plain text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const YT_RE = /^(https?:\/\/)?((www\.|m\.|music\.)?youtube\.com\/(watch\?|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)/i;

const run = (file, args, timeout = 90000) => new Promise(resolve => {
  execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) =>
    resolve({ ok: !err, stdout: String(so || ''), stderr: String(se || '') }));
});

// WebVTT → dedup'd plain text (YouTube auto-captions repeat each line many times)
const vttToText = vtt => {
  const seen = new Set(); const out = [];
  for (let line of String(vtt).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:') || line.includes('-->')) continue;
    const clean = line.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (clean && !seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  return out.join(' ');
};

export const getTranscript = async (url, { maxChars = 30000 } = {}) => {
  const u = String(url || '').trim();
  if (!YT_RE.test(u)) return harden({ ok: false, error: 'not a YouTube URL (only youtube.com / youtu.be are supported)' });
  let dir;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-'));
    const out = path.join(dir, 't');
    const meta = await run('yt-dlp', ['--no-warnings', '--skip-download', '--print', '%(title)s', u], 60000);
    const title = meta.ok ? (meta.stdout.trim().split('\n')[0] || '') : '';
    const dl = await run('yt-dlp', ['--no-warnings', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt', '-o', out, u], 90000);
    const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.vtt'));
    if (!files.length) return harden({ ok: false, error: 'no subtitles/captions available for this video', title, url: u, detail: dl.stderr.slice(-200) });
    const pick = files.find(f => !/auto/i.test(f)) || files[0]; // prefer a manual sub over auto-captions
    const text = vttToText(await fs.promises.readFile(path.join(dir, pick), 'utf8'));
    if (!text) return harden({ ok: false, error: 'captions were empty after parsing', title, url: u });
    return harden({ ok: true, title, url: u, source: /auto/i.test(pick) ? 'auto-captions' : 'manual-subtitles', chars: text.length, text: text.slice(0, maxChars) });
  } catch (e) {
    return harden({ ok: false, error: /** @type {Error} */ (e).message });
  } finally {
    if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
harden(getTranscript);
