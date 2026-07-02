// contacts-email.test.mjs — T-TEST-3 · external-effect caps: contacts.mjs (CardDAV address book) and
// email-smtp.mjs (SMTP sender). NO real mail is ever sent and NO real CardDAV server is contacted:
//   • contacts: globalThis.fetch is stubbed to a scripted CardDAV server (PROPFIND/REPORT/PUT).
//   • email:    tls.connect is stubbed to a scripted in-memory SMTP peer that records every command.
//
// The SEC-6 red-line under test: an agent-proposed `to`/`from` carrying CR/LF must NOT be able to inject
// extra SMTP commands or headers. We assert the stripping holds at buildMessage AND at the wire (RCPT TO).
//
// NOTE on the "confirm-gate": neither module contains the human-confirm gate — that lives upstream in
// agent-caps.mjs (contacts add/update are reached only via a confirmed proposal's commit(); email send is
// behind a confirmable proposal). These modules are the transport. What we CAN assert here is that a
// rejected/invalid send performs NO network effect, and that the write payloads are correct.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';

import { makeContacts } from './contacts.mjs';
import { stripCrlf, buildMessage, sendMail } from './email-smtp.mjs';

// =========================================================================
// email-smtp.mjs
// =========================================================================

test('stripCrlf flattens CR/LF (and collapses runs) so nothing can start a new command/header line', () => {
  assert.equal(stripCrlf('plain@x.com'), 'plain@x.com');
  assert.equal(stripCrlf('a@x.com\r\nBcc: evil@y.com'), 'a@x.com Bcc: evil@y.com');
  assert.equal(stripCrlf('a\n\r\n\nb'), 'a b'); // a run of CR/LF collapses to ONE space
  assert.equal(stripCrlf('  trimmed@x.com  '), 'trimmed@x.com');
  assert.equal(stripCrlf(null), '');
});

test('buildMessage strips CR/LF from From/To/Subject (SEC-6) and dot-stuffs the body', () => {
  const msg = buildMessage({
    from: 'me@x.com',
    to: 'victim@x.com\r\nBcc: attacker@evil.com',
    subject: 'hi\r\nX-Injected: yes',
    body: 'line1\n.\nline2', // a lone "." would end DATA early → must be dot-stuffed to ".."
  });
  const headerBlock = msg.split('\r\n\r\n')[0];
  const headerLines = headerBlock.split('\r\n');
  // exactly one To: and one Subject: header — the injected CR/LF did NOT create new header lines
  assert.equal(headerLines.filter(l => l.startsWith('To:')).length, 1);
  assert.equal(headerLines.filter(l => /^Bcc:/i.test(l)).length, 0);
  assert.equal(headerLines.filter(l => /^X-Injected:/i.test(l)).length, 0);
  assert.ok(headerLines.some(l => l === 'To: victim@x.com Bcc: attacker@evil.com'));
  // dot-stuffing: the lone "." line became ".."
  assert.ok(msg.includes('\r\n..\r\n'));
});

test('sendMail rejects an incomplete config WITHOUT opening a connection (no send on invalid)', async () => {
  let connected = false;
  const realConnect = tls.connect;
  tls.connect = () => { connected = true; throw new Error('should not connect'); };
  try {
    await assert.rejects(
      sendMail({ host: 'smtp.x.com', user: 'u', pass: 'p', from: 'me@x.com' /* no `to` */, subject: 's', body: 'b' }),
      /missing smtp config/,
    );
    assert.equal(connected, false, 'validation must short-circuit before tls.connect');
  } finally {
    tls.connect = realConnect;
  }
});

// A scripted in-memory SMTP peer: emits a greeting, then one reply per command written. Records every
// command sendMail writes so we can inspect the RCPT TO / MAIL FROM lines that actually hit the wire.
const installFakeSmtp = () => {
  const realConnect = tls.connect;
  const sockets = [];
  // one reply per protocol step (codes matched by sendMail's state machine)
  const replies = ['220 ready', '250 hello', '334 user', '334 pass', '235 auth ok', '250 mail ok', '250 rcpt ok', '354 send body', '250 accepted', '221 bye'];
  tls.connect = () => {
    const s = new EventEmitter();
    s.writes = [];
    s.setTimeout = () => {};
    s.destroy = () => {};
    let i = 0;
    const emitReply = () => setImmediate(() => s.emit('data', Buffer.from(`${replies[i]}\r\n`)));
    s.write = data => { s.writes.push(String(data)); i += 1; emitReply(); return true; };
    sockets.push(s);
    emitReply(); // greeting (replies[0]) before any command
    return s;
  };
  return { sockets, restore: () => { tls.connect = realConnect; } };
};

test('sendMail: a CR/LF-laced `to` produces exactly ONE RCPT TO on the wire (SEC-6 at the socket)', async () => {
  const fake = installFakeSmtp();
  try {
    const res = await sendMail({
      host: 'smtp.x.com', user: 'u', pass: 'p',
      from: 'me@x.com',
      to: 'victim@x.com\r\nRCPT TO:<attacker@evil.com>',
      subject: 'hi', body: 'hello',
    });
    assert.deepEqual(res, { ok: true });
    const writes = fake.sockets[0].writes;
    const rcpts = writes.filter(w => w.startsWith('RCPT TO:'));
    assert.equal(rcpts.length, 1, 'the injected CR/LF must NOT create a second RCPT TO command');
    // the injected address was flattened into the single (harmless) recipient string
    assert.ok(rcpts[0].includes('victim@x.com RCPT TO:<attacker@evil.com>'));
    // and no stray bare-command line for the attacker was written
    assert.ok(!writes.some(w => w.trim() === 'RCPT TO:<attacker@evil.com>'));
  } finally {
    fake.restore();
  }
});

// =========================================================================
// contacts.mjs — scripted CardDAV over a stubbed global fetch (no network)
// =========================================================================

const vcf = ({ uid, fn, email = '', extra = '' }) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\n${email ? `EMAIL;TYPE=INTERNET:${email}\r\n` : ''}${extra}END:VCARD\r\n`;

const propfindXml = uids =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${uids
    .map(u => `<d:response><d:href>/dav/${u}.vcf</d:href><d:propstat><d:prop><d:getcontenttype>text/vcard</d:getcontenttype></d:prop></d:propstat></d:response>`)
    .join('')}</d:multistatus>`;

const reportXml = cards =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${cards
    .map(c => `<d:response><d:href>/dav/${c.uid}.vcf</d:href><d:propstat><d:prop><card:address-data>${vcf(c)}</card:address-data></d:prop></d:propstat></d:response>`)
    .join('')}</d:multistatus>`;

// Install a fake CardDAV server over globalThis.fetch. Returns { calls, puts }.
const installFakeCardDav = (cards) => {
  const realFetch = globalThis.fetch;
  const calls = { PROPFIND: 0, REPORT: 0, PUT: 0, DELETE: 0 };
  const puts = [];
  const resp = (status, text) => ({ status, ok: status < 300, text: async () => text, json: async () => ({}) });
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls[method] = (calls[method] || 0) + 1;
    if (method === 'PROPFIND') return resp(207, propfindXml(cards.map(c => c.uid)));
    if (method === 'REPORT') return resp(207, reportXml(cards));
    if (method === 'PUT') { puts.push({ url, body: opts.body }); return resp(201, ''); }
    if (method === 'DELETE') return resp(204, '');
    return resp(404, '');
  };
  return { calls, puts, restore: () => { globalThis.fetch = realFetch; } };
};

const CFG = { baseUrl: 'https://cloud.example', user: 'dan', pass: 'app-pw' };

test('contacts.search: reads (free) and returns slimmed hits; get() adds the note', async () => {
  const fake = installFakeCardDav([
    { uid: 'u1', fn: 'Ada Lovelace', email: 'ada@x.com', extra: 'NOTE:first programmer\r\n' },
    { uid: 'u2', fn: 'Bob Jones', email: 'bob@y.com' },
  ]);
  try {
    const c = makeContacts(CFG);
    const hits = await c.search('ada');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].handle, 'u1');
    assert.equal(hits[0].name, 'Ada Lovelace');
    assert.deepEqual(hits[0].emails, ['ada@x.com']);
    assert.equal(hits[0].note, undefined, 'search result is slimmed (no note)');
    const got = await c.get('u1');
    assert.equal(got.note, 'first programmer'); // get() surfaces the note
    assert.equal(await c.count(), 2);
  } finally {
    fake.restore();
  }
});

test('contacts: results are cached (a second read does not re-hit the server within the TTL)', async () => {
  const fake = installFakeCardDav([{ uid: 'u1', fn: 'Ada', email: 'ada@x.com' }]);
  try {
    const c = makeContacts(CFG);
    await c.search('a');
    await c.search('a');
    await c.count();
    assert.equal(fake.calls.PROPFIND, 1, 'one PROPFIND for the whole 30s window');
    assert.equal(fake.calls.REPORT, 1);
  } finally {
    fake.restore();
  }
});

test('contacts.add: PUTs a well-formed vCard to <uid>.vcf and returns the new handle', async () => {
  const fake = installFakeCardDav([]);
  try {
    const c = makeContacts(CFG);
    const r = await c.add({ fn: 'Grace Hopper', emails: ['grace@navy.mil'], org: 'US Navy' });
    assert.equal(r.ok, true);
    assert.equal(r.name, 'Grace Hopper');
    assert.equal(fake.puts.length, 1);
    const { url, body } = fake.puts[0];
    assert.ok(url.endsWith(`${encodeURIComponent(r.handle)}.vcf`));
    assert.ok(body.includes('BEGIN:VCARD'));
    assert.ok(body.includes('FN:Grace Hopper'));
    assert.ok(body.includes('EMAIL;TYPE=INTERNET:grace@navy.mil'));
    assert.ok(body.includes('ORG:US Navy'));
  } finally {
    fake.restore();
  }
});

test('contacts.update: merges fields and PRESERVES unmodeled props (ADR/BDAY) on the round-trip', async () => {
  const fake = installFakeCardDav([
    { uid: 'u1', fn: 'Ada Lovelace', email: 'ada@x.com', extra: 'BDAY:18151210\r\nADR:;;London;;;;\r\nNOTE:old note\r\n' },
  ]);
  try {
    const c = makeContacts(CFG);
    const r = await c.update('u1', { note: 'new note' });
    assert.equal(r.ok, true);
    const { body } = fake.puts[0];
    assert.ok(body.includes('NOTE:new note'), 'the changed field is written');
    assert.ok(body.includes('BDAY:18151210'), 'unmodeled BDAY preserved');
    assert.ok(body.includes('ADR:;;London;;;;'), 'unmodeled ADR preserved');
    assert.ok(body.includes('EMAIL;TYPE=INTERNET:ada@x.com'), 'untouched email preserved');
  } finally {
    fake.restore();
  }
});

test('contacts.update: rejects an unknown handle (no PUT happens)', async () => {
  const fake = installFakeCardDav([{ uid: 'u1', fn: 'Ada' }]);
  try {
    const c = makeContacts(CFG);
    await assert.rejects(c.update('nope', { note: 'x' }), /no contact for handle/);
    assert.equal(fake.puts.length, 0);
  } finally {
    fake.restore();
  }
});
