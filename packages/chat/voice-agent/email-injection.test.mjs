// email-injection.test.mjs — regression proof that the SMTP sender strips CR/LF from `to`/`from`.
//
// The hole (fixed, email-smtp.mjs): only `subject` was CR/LF-stripped. An agent-proposed `to` (or `from`)
// containing "\r\n" was interpolated raw into RCPT TO:<…> / the To:/From: headers, enabling SMTP-command
// and header injection (extra recipients, spoofed headers, a smuggled DATA body). Now both are stripped.
//
// Run: node --test email-injection.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, stripCrlf } from './email-smtp.mjs';

test('stripCrlf removes CR/LF', () => {
  assert.equal(stripCrlf('a\r\nb'), 'a b');
  assert.equal(stripCrlf('victim@x.com\r\nBcc: evil@x.com'), 'victim@x.com Bcc: evil@x.com');
  assert.equal(stripCrlf('plain@x.com'), 'plain@x.com');
});

test('buildMessage cannot be header-injected via `to`', () => {
  const msg = buildMessage({
    from: 'me@x.com',
    to: 'victim@x.com\r\nBcc: evil@x.com\r\nSubject: SPOOFED',
    subject: 'hello',
    body: 'hi',
  });
  const headerBlock = msg.split('\r\n\r\n')[0];
  const lines = headerBlock.split('\r\n');
  // exactly one To: line, no injected Bcc: / spoofed Subject header from the `to` field.
  assert.equal(lines.filter(l => /^To:/i.test(l)).length, 1, 'exactly one To: header');
  assert.equal(lines.filter(l => /^Bcc:/i.test(l)).length, 0, 'no injected Bcc: header');
  assert.equal(lines.filter(l => /^Subject:/i.test(l)).length, 1, 'no injected extra Subject header');
  assert.match(lines.find(l => /^Subject:/i.test(l)), /^Subject: hello$/, 'the real subject survives');
  assert.ok(!/\r\n/.test(lines.find(l => /^To:/i.test(l))), 'the To: line carries no CRLF');
});

test('buildMessage cannot be injected via `from` either', () => {
  const msg = buildMessage({ from: 'me@x.com\r\nX-Evil: 1', to: 'you@x.com', subject: 's', body: 'b' });
  const lines = msg.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(lines.filter(l => /^X-Evil:/i.test(l)).length, 0, 'no injected header from `from`');
  assert.equal(lines.filter(l => /^From:/i.test(l)).length, 1, 'exactly one From: header');
});
