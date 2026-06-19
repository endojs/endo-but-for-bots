// contacts.mjs — dan's address book (NextCloud Contacts over CardDAV) as a
// read-free / write-by-proposal endo object (see AUTHORITY-MODEL.md).
//
//   READ  (free):   search(query), get(handle), count()        — no side effects
//   WRITE (gated):  add(fields), update(handle, fields)         — called ONLY by a
//                   confirmed proposal's commit() in agent-caps; the LLM never holds
//                   these (it holds the propose* verbs).
//
// CardDAV access reuses the existing NextCloud app password (passed in). We list
// hrefs with PROPFIND, then fetch all vCards in one addressbook-multiget REPORT —
// robust + two requests regardless of contact count.
import { Far } from '@endo/marshal';
import crypto from 'node:crypto';

const decodeXml = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&'); // last, so &amp;lt; → &lt; (not <)

// vCard value (un)escaping per RFC 6350 §3.4
const vEsc = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const vUnesc = v => String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

const MANAGED = new Set(['BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N', 'EMAIL', 'TEL', 'ORG', 'NOTE', 'REV']);

const parseVCard = (raw, href) => {
  const unfolded = String(raw).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const c = { href: href || '', uid: '', fn: '', emails: [], tels: [], org: '', note: '', raw: String(raw), extra: [] };
  for (const line of unfolded.split(/\r\n|\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const keyfull = line.slice(0, idx);
    const key = keyfull.split(';')[0].toUpperCase();
    const val = vUnesc(line.slice(idx + 1));
    if (key === 'UID') c.uid = val;
    else if (key === 'FN') c.fn = val;
    else if (key === 'EMAIL') c.emails.push(val);
    else if (key === 'TEL') c.tels.push(val);
    else if (key === 'ORG') c.org = val.replace(/;/g, ' ').trim();
    else if (key === 'NOTE') c.note = val;
    if (!MANAGED.has(key)) c.extra.push(line); // preserve unmodeled props (ADR, BDAY, PHOTO…) on edit
  }
  return c;
};

const buildVCard = ({ uid, fn, emails = [], tels = [], org, note }, extra = []) => {
  const parts = String(fn || '').trim().split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${vEsc(fn)}`, `N:${vEsc(last)};${vEsc(first)};;;`];
  for (const e of emails) if (e) lines.push(`EMAIL;TYPE=INTERNET:${vEsc(e)}`);
  for (const t of tels) if (t) lines.push(`TEL:${vEsc(t)}`);
  if (org) lines.push(`ORG:${vEsc(org)}`);
  if (note) lines.push(`NOTE:${vEsc(note)}`);
  for (const x of extra) lines.push(x); // preserved unmodeled props
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, 'END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
};

const slim = c => ({ handle: c.uid, name: c.fn, emails: c.emails, tels: c.tels, org: c.org });

export const makeContacts = ({ baseUrl, user, pass, addressbook = 'contacts' }) => {
  const root = `${String(baseUrl).replace(/\/$/, '')}/remote.php/dav/addressbooks/users/${user}/${addressbook}/`;
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const hdr = extra => ({ Authorization: auth, ...extra });

  const listHrefs = async () => {
    const r = await fetch(root, { method: 'PROPFIND', headers: hdr({ Depth: '1', 'content-type': 'application/xml; charset=utf-8' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontenttype/><d:getetag/></d:prop></d:propfind>' });
    if (r.status === 404) return [];
    if (r.status !== 207 && r.status !== 200) throw new Error(`CardDAV PROPFIND ${r.status}`);
    const xml = await r.text();
    const hrefs = [];
    for (const m of xml.matchAll(/<[^>]*:?response[^>]*>([\s\S]*?)<\/[^>]*:?response>/gi)) {
      const hm = /<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i.exec(m[1]);
      const href = hm ? decodeXml(hm[1]).trim() : '';
      if (href && /\.vcf$/i.test(href)) hrefs.push(href);
    }
    return hrefs;
  };

  const fetchAll = async () => {
    const hrefs = await listHrefs();
    if (!hrefs.length) return [];
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data/></d:prop>${hrefs.map(h => `<d:href>${h}</d:href>`).join('')}</card:addressbook-multiget>`;
    const r = await fetch(root, { method: 'REPORT', headers: hdr({ Depth: '1', 'content-type': 'application/xml; charset=utf-8' }), body });
    if (r.status !== 207 && r.status !== 200) throw new Error(`CardDAV REPORT ${r.status}`);
    const xml = await r.text();
    const out = [];
    for (const m of xml.matchAll(/<[^>]*:?response[^>]*>([\s\S]*?)<\/[^>]*:?response>/gi)) {
      const block = m[1];
      const hm = /<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i.exec(block);
      const dm = /<[^>]*:?address-data[^>]*>([\s\S]*?)<\/[^>]*:?address-data>/i.exec(block);
      if (!dm) continue;
      const vc = decodeXml(dm[1]);
      if (/BEGIN:VCARD/i.test(vc)) out.push(parseVCard(vc, hm ? decodeXml(hm[1]).trim() : ''));
    }
    return out;
  };

  let cache = null;
  let cacheAt = 0;
  const all = async () => {
    if (!cache || Date.now() - cacheAt > 30000) { cache = await fetchAll(); cacheAt = Date.now(); }
    return cache;
  };
  const invalidate = () => { cache = null; cacheAt = 0; };
  const find = async handle => (await all()).find(c => c.uid === handle || c.href.endsWith(`/${handle}.vcf`) || c.href.endsWith(handle));

  const put = async (uid, vcard) => {
    const r = await fetch(`${root}${encodeURIComponent(uid)}.vcf`, { method: 'PUT', headers: hdr({ 'content-type': 'text/vcard; charset=utf-8' }), body: vcard });
    if (![200, 201, 204].includes(r.status)) throw new Error(`CardDAV PUT ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    invalidate();
  };

  return Far('Contacts', {
    help: () => `Your NextCloud address book (CardDAV ${addressbook}). READ is free (search/get); add/update are PROPOSED — you confirm before any write.`,
    count: async () => (await all()).length,
    search: async (query = '') => {
      const q = String(query || '').toLowerCase();
      const list = await all();
      const hits = q ? list.filter(c => [c.fn, c.org, ...c.emails, ...c.tels].join(' ').toLowerCase().includes(q)) : list;
      return harden(hits.slice(0, 25).map(slim));
    },
    get: async handle => { const c = await find(String(handle || '')); return c ? harden({ ...slim(c), note: c.note }) : null; },
    // WRITE (reached only via a confirmed proposal's commit):
    add: async ({ fn, emails = [], tels = [], org = '', note = '' }) => {
      const uid = crypto.randomUUID();
      await put(uid, buildVCard({ uid, fn, emails, tels, org, note }));
      return harden({ ok: true, handle: uid, name: String(fn || '') });
    },
    update: async (handle, fields = {}) => {
      const cur = await find(String(handle || ''));
      if (!cur) throw new Error(`no contact for handle ${handle}`);
      const merged = {
        uid: cur.uid,
        fn: fields.fn != null && fields.fn !== '' ? fields.fn : cur.fn,
        emails: fields.emails != null ? fields.emails : cur.emails,
        tels: fields.tels != null ? fields.tels : cur.tels,
        org: fields.org != null && fields.org !== '' ? fields.org : cur.org,
        note: fields.note != null && fields.note !== '' ? fields.note : cur.note,
      };
      await put(cur.uid, buildVCard(merged, cur.extra)); // cur.extra preserves unmodeled props
      return harden({ ok: true, handle: cur.uid, name: merged.fn });
    },
    // admin/test only (not a granted verb): delete by handle
    remove: async handle => {
      const c = await find(String(handle || ''));
      if (!c) return harden({ ok: false, error: 'not found' });
      const r = await fetch(`${String(baseUrl).replace(/\/$/, '')}${c.href.startsWith('/') ? c.href : `/${c.href}`}`, { method: 'DELETE', headers: hdr({}) });
      invalidate();
      return harden({ ok: [200, 204].includes(r.status), status: r.status });
    },
  });
};
harden(makeContacts);
