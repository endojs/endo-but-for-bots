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
import crypto from 'node:crypto';

// A stable, UNGUESSABLE private topic for a per-user key (a node id / cap). On a public ntfy server the topic
// name IS the capability (a swissnum-shaped secret), so each user gets their own feed without server auth.
export const topicForKey = key => `field-${crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 24)}`;
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

export const notify = async ({ title, message = '', priority = 'default', tags = [], click = '', note = '', audio = '', feed = true, topic = '' } = {}) => {
  let cfg;
  try { cfg = JSON.parse(await fsp.readFile(CFG, 'utf8')); } catch { return { ok: false, error: 'no field-notify config' }; }
  const dest = String(topic || cfg.topic || ''); // route to an explicit per-user topic when given, else the default
  if (!cfg.server || !dest) return { ok: false, error: 'config missing server/topic' };
  // Publish via ntfy's JSON format (POST to the server root, topic in the body) rather than HTTP HEADERS.
  // Headers are ByteString (Latin-1) so an emoji in Title/Tags (e.g. "🎙 Voice note…") throws
  // "Cannot convert argument to a ByteString" and the push silently fails. JSON body is UTF-8 → emoji-safe.
  const PRI = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
  const body = { topic: dest, message: String(message || '') };
  if (title) body.title = String(title);
  const pr = PRI[String(priority)] ?? Number(priority);
  if (Number.isFinite(pr) && pr >= 1 && pr <= 5) body.priority = pr;
  if (tags && tags.length) body.tags = (Array.isArray(tags) ? tags : [tags]).map(String);
  if (click) body.click = String(click);
  // Mirror to the feed first (durable), so the message is reviewable even if the
  // ntfy push itself fails. Operational pings (feed:false) skip this.
  if (feed) await recordToFeed({ title, message, click, note, audio });
  try {
    const res = await fetch(`${cfg.server}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
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
