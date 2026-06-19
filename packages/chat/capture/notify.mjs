#!/usr/bin/env node
// notify.mjs — push a notification to dan's phone via the self-hosted ntfy on
// friky. Content is served from friky (tailnet); only a hashed wake-up goes
// through ntfy.sh's APNs proxy for iOS, so message text stays private.
//
// Config: ~/.config/field-notify/config.json  { server, topic }
//
// Library:  import { notify } from './notify.mjs'
//   await notify({ title, message, priority, tags, click })
// CLI:      node notify.mjs --title T --message M [--priority high] [--tags a,b] [--click URL]

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CFG = path.join(os.homedir(), '.config/field-notify/config.json');
export const DASHBOARD = 'http://100.83.80.102:8771/';
const FEED_FILE = path.join(os.homedir(), '.local/state/field-dashboard/feed.json');

// Mirror a push into the dashboard feed so a pushed answer/alert is reviewable
// from the home page until dismissed. kind:'push' → surfaced in "Needs your
// input". Pass note (a processed-capture relpath) + audio (the recording) so the
// item links the original recording and the doc. Operational pings should pass
// feed:false (they carry no reviewable content — e.g. "Input review done").
const recordToFeed = async ({ title, message, click, note = '', audio = '' }) => {
  try {
    let feed = { updated: '', entries: [] };
    try { const j = JSON.parse(await fsp.readFile(FEED_FILE, 'utf8')); if (Array.isArray(j.entries)) feed = j; } catch { /* fresh */ }
    const date = new Date().toISOString();
    feed.entries = feed.entries.filter(e => e.kind !== 'push' || e.title !== title || e.body !== message); // de-dupe identical re-pushes
    feed.entries.push({
      id: `push-${date}`, date,
      title: title || 'Notification', body: message || '',
      status: '📲 pushed to your phone', kind: 'push',
      note: note || '',
      audio: audio ? path.basename(audio) : '', // basename → served by dashboard /audio/
      links: click && /^https?:/.test(click) && click !== DASHBOARD ? [{ label: 'open', url: click }] : [],
      muddleUrl: null,
    });
    feed.entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    feed.updated = date;
    await fsp.mkdir(path.dirname(FEED_FILE), { recursive: true });
    await fsp.writeFile(FEED_FILE, JSON.stringify(feed, null, 2));
  } catch { /* feed mirroring is best-effort; never block the push */ }
};

export const notify = async ({ title, message = '', priority = 'default', tags = [], click = '', note = '', audio = '', feed = true } = {}) => {
  let cfg;
  try { cfg = JSON.parse(await fsp.readFile(CFG, 'utf8')); } catch { return { ok: false, error: 'no field-notify config' }; }
  if (!cfg.server || !cfg.topic) return { ok: false, error: 'config missing server/topic' };
  const headers = { 'content-type': 'text/plain' };
  if (title) headers.Title = title;
  if (priority) headers.Priority = priority;
  if (tags && tags.length) headers.Tags = Array.isArray(tags) ? tags.join(',') : String(tags);
  if (click) headers.Click = click;
  // Mirror to the feed first (durable), so the message is reviewable even if the
  // ntfy push itself fails. Operational pings (feed:false) skip this.
  if (feed) await recordToFeed({ title, message, click, note, audio });
  try {
    const res = await fetch(`${cfg.server}/${cfg.topic}`, {
      method: 'POST', headers, body: message, signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = process.argv.slice(2); const a = {};
  for (let i = 0; i < v.length; i += 1) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[(i += 1)] : 'true';
  const r = await notify({ title: a.title, message: a.message || '', priority: a.priority, tags: a.tags ? a.tags.split(',') : [], click: a.click || DASHBOARD, note: a.note && a.note !== 'true' ? a.note : '', audio: a.audio && a.audio !== 'true' ? a.audio : '', feed: !a['no-feed'] });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
