// email-smtp.mjs — a tiny, dependency-free SMTP-over-implicit-TLS (port 465)
// sender with AUTH LOGIN. The field agent's `email` power uses this to actually
// send (still behind a confirmable proposal — the agent only PROPOSES; a human
// confirms, and only then does this run). Config (host/user/pass/from) lives in
// ~/.config/field-agent/email.json, never in code or chat.
//
// Deliberately minimal: one plaintext message, one recipient, implicit TLS on
// 465 (no STARTTLS dance). Resolves { ok:true } or rejects with the SMTP error;
// the caller falls back to drafting on any failure.
import tls from 'node:tls';

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

// SECURITY: strip CR/LF from any value interpolated into an SMTP command or header line. Without this an
// agent-proposed `to` (or `from`) containing "\r\n" injects extra RCPT TO / arbitrary headers (SMTP/header
// injection — extra recipients, spoofed headers, a smuggled DATA body). Only `subject` was stripped before.
export const stripCrlf = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
harden(stripCrlf);

export const buildMessage = ({ from, to, subject, body }) => {
  const headers = [
    `From: ${stripCrlf(from)}`,
    `To: ${stripCrlf(to)}`,
    `Subject: ${stripCrlf(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].join('\r\n');
  // CRLF line endings + dot-stuffing (a line that is just "." would end DATA early)
  const safeBody = String(body == null ? '' : body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${headers}\r\n\r\n${safeBody}`;
};
harden(buildMessage);

export const sendMail = ({ host, port = 465, user, pass, from, to, subject, body, timeoutMs = 20000 }) =>
  new Promise((resolve, reject) => {
    if (!host || !user || !pass || !from || !to) {
      reject(new Error('missing smtp config (need host, user, pass, from, to)'));
      return;
    }
    // CR/LF-strip the envelope addresses before they reach the RCPT TO / MAIL FROM commands AND the
    // To:/From: headers (buildMessage) — closes SMTP-command + header injection via an agent-proposed `to`.
    const safeFrom = stripCrlf(from);
    const safeTo = stripCrlf(to);
    // steps[i] = [ expected reply code for the message we just received, command to send next ]
    const steps = [
      ['220', `EHLO ${host}`],
      ['250', 'AUTH LOGIN'],
      ['334', b64(user)],
      ['334', b64(pass)],
      ['235', `MAIL FROM:<${safeFrom}>`],
      ['250', `RCPT TO:<${safeTo}>`],
      ['250', 'DATA'],
      ['354', `${buildMessage({ from: safeFrom, to: safeTo, subject, body })}\r\n.`],
      ['250', 'QUIT'],
      ['221', null],
    ];
    let i = 0;
    let acc = '';
    let settled = false;
    const sock = tls.connect({ host, port: Number(port) || 465, servername: host });
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* best effort */ }
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(val);
    };
    sock.setTimeout(timeoutMs, () => done(new Error('SMTP timeout')));
    sock.on('error', e => done(e instanceof Error ? e : new Error(String(e))));
    sock.on('data', chunk => {
      acc += chunk.toString('utf8');
      const lines = acc.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return; // multiline reply (NNN-…) still arriving
      const code = last.slice(0, 3);
      const [expect, cmd] = steps[i];
      if (code !== expect) { done(new Error(`SMTP ${code} (wanted ${expect}): ${last}`)); return; }
      acc = '';
      if (cmd != null) { try { sock.write(`${cmd}\r\n`); } catch (e) { done(e); return; } }
      i += 1;
      if (i >= steps.length) done(null, { ok: true });
    });
  });
harden(sendMail);
