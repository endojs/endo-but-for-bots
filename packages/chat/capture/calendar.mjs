// calendar.mjs — the agent's NextCloud calendar capability. Lets it freely
// create + remove events on its own "agent" calendar (CalDAV). For now it uses
// dan's app password (per dan); the cleaner future is a dedicated NextCloud user
// for the agent. Credentials come from ~/.config/field-calendar/config.json:
//   { "server": "http://tower.taildd002.ts.net:8888", "user": "dan",
//     "appPassword": "<nextcloud app password>", "calendar": "agent" }
// (tailnet MagicDNS host — trusted_domain, no ngrok; app password kept out of git/chat.)

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CFG = path.join(os.homedir(), '.config/field-calendar/config.json');
const H = x => (typeof harden === 'function' ? harden(x) : x);

const cfg = async () => {
  const c = JSON.parse(await fsp.readFile(CFG, 'utf8'));
  if (!c.appPassword) throw new Error('field-calendar config has no appPassword yet');
  c.base = `${c.server}/remote.php/dav/calendars/${c.user}/${c.calendar}/`;
  c.auth = `Basic ${Buffer.from(`${c.user}:${c.appPassword}`).toString('base64')}`;
  return c;
};
const icalTime = v => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${v}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};
const esc = s => String(s == null ? '' : s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

// plain core
export const createEvent = async ({ summary, start, end, description = '', location = '', uid } = {}) => {
  if (!summary || !start) throw new Error('createEvent needs {summary, start}');
  const c = await cfg();
  const id = uid || crypto.randomUUID();
  const dtend = end || new Date(new Date(start).getTime() + 3600000).toISOString();
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//field//capture-agent//EN', 'BEGIN:VEVENT',
    `UID:${id}`, `DTSTAMP:${icalTime(Date.now())}`, `DTSTART:${icalTime(start)}`, `DTEND:${icalTime(dtend)}`,
    `SUMMARY:${esc(summary)}`, description ? `DESCRIPTION:${esc(description)}` : '', location ? `LOCATION:${esc(location)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const res = await fetch(`${c.base}${id}.ics`, { method: 'PUT', headers: { Authorization: c.auth, 'Content-Type': 'text/calendar; charset=utf-8' }, body: ics, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { ok: true, uid: id, status: res.status };
};
export const removeEvent = async uid => {
  if (!uid) throw new Error('removeEvent needs a uid');
  const c = await cfg();
  const res = await fetch(`${c.base}${uid}.ics`, { method: 'DELETE', headers: { Authorization: c.auth }, signal: AbortSignal.timeout(15000) });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${res.status}`);
  return { ok: true, status: res.status };
};
export const listEvents = async () => {
  const c = await cfg();
  const body = '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';
  const res = await fetch(c.base, { method: 'REPORT', headers: { Authorization: c.auth, 'Content-Type': 'application/xml', Depth: '1' }, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`REPORT ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/UID:([^\r\n]+)[\s\S]*?SUMMARY:([^\r\n]+)/g)) out.push({ uid: m[1].trim(), summary: m[2].trim() });
  return out;
};

// endo object (lazy Far so plain core + CLI run without SES)
export const makeCalendar = async () => {
  const { Far } = await import('@endo/marshal');
  return Far('Calendar', {
    help: () => H("The agent's NextCloud 'agent' calendar (CalDAV). Freely create/remove events. " +
      'createEvent({summary,start,end,description,location}) → uid; removeEvent(uid); listEvents(). ' +
      'Times are ISO; uses dan\'s app password for now (a dedicated agent NextCloud user is the future).'),
    createEvent: async a => H(await createEvent(a)),
    removeEvent: async uid => H(await removeEvent(uid)),
    listEvents: async () => H(await listEvents()),
  });
};

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = process.argv.slice(2); const cmd = v[0]; const a = {};
  for (let i = 1; i < v.length; i += 1) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[(i += 1)] : 'true';
  const out = cmd === 'create' ? await createEvent({ summary: a.summary, start: a.start, end: a.end, description: a.desc, location: a.location })
    : cmd === 'remove' ? await removeEvent(a.uid)
      : cmd === 'list' ? await listEvents()
        : (() => { throw new Error('commands: create --summary --start --end [--desc] | remove --uid | list'); })();
  console.log(JSON.stringify(out));
}
