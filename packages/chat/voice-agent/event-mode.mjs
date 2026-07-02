// event-mode.mjs — EVENT_MODE TLS helper (P6, LAN event mode for DWeb Camp / meshcore).
//
// getUserMedia (the browser mic) requires a SECURE CONTEXT. On the archua NUC that is supplied by
// `tailscale serve` HTTPS; at a venue with no tailscale/internet there is no such fronting, so when
// EVENT_MODE is on we serve HTTPS ourselves with a self-signed cert. Node's stdlib can PARSE an X.509 but
// cannot MINT a self-signed one, so we shell out to `openssl` (present on archua + a typical mac) exactly
// once — the pair is cached under CONFIG_DIR/event-tls (the field-config seam) and reused on later boots.
//
// Kept OUT of field-config.mjs (which must stay pure — it is imported from plain-node tooling and the P5
// drive scripts). This module is imported ONLY by server.mjs, and only its `ensureEventCert` runs, and only
// when EVENT_MODE is on. Users must accept the self-signed cert ONCE per device (browser warning → proceed);
// after that the mic works on the LAN. See RUN-ON-MAC.md "EVENT_MODE".

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import { EVENT_CERT_DIR, EVENT_CERT_FILE, EVENT_KEY_FILE } from './field-config.mjs';

// Importable from BOTH the SES server (harden is a global) AND plain-node tests — fall back to identity.
const _harden = typeof harden === 'function' ? harden : x => x;

// does an existing cert already cover this IP in its SAN? (so we don't regenerate every boot, but DO
// regenerate if the LAN address changed and the old SAN no longer matches — a stale SAN = browser reject).
const certCoversIp = (certPem, ip) => {
  if (!ip) return true;
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return san.includes(`IP Address:${ip}`);
  } catch { return false; }
};

/**
 * Ensure a self-signed cert/key pair exists at the EVENT_CERT_* paths, with a SAN covering the given LAN IPs
 * plus loopback + localhost. Idempotent: reuses an existing pair when it already covers every requested IP.
 * Returns `{ cert, key }` PEM buffers for https.createServer, or `null` if generation failed (openssl absent)
 * so the caller can fall back to plain HTTP on the same LAN address without destabilizing the service.
 *
 * @param {string[]} lanIps
 * @param {(...a: any[]) => void} [log]
 * @returns {{cert: Buffer, key: Buffer} | null}
 */
export const ensureEventCert = (lanIps = [], log = () => {}) => {
  try {
    const ips = [...new Set([...lanIps.filter(Boolean), '127.0.0.1'])];
    let ok = false;
    try {
      const existing = fs.readFileSync(EVENT_CERT_FILE, 'utf8');
      fs.accessSync(EVENT_KEY_FILE);
      ok = ips.every(ip => certCoversIp(existing, ip));
    } catch { ok = false; }
    if (!ok) {
      fs.mkdirSync(EVENT_CERT_DIR, { recursive: true });
      const san = [...ips.map(ip => `IP:${ip}`), 'DNS:localhost'].join(',');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', EVENT_KEY_FILE, '-out', EVENT_CERT_FILE,
        '-days', '3650', '-subj', '/CN=agentc-event',
        '-addext', `subjectAltName=${san}`,
      ], { stdio: 'ignore' });
      try { fs.chmodSync(EVENT_KEY_FILE, 0o600); } catch { /* best-effort */ }
      log('event-tls', `generated self-signed cert for ${san} (accept it once per device)`);
    }
    return { cert: fs.readFileSync(EVENT_CERT_FILE), key: fs.readFileSync(EVENT_KEY_FILE) };
  } catch (e) {
    log('event-tls', `cert generation FAILED (${(e && e.message) || e}); serving plain HTTP on the LAN — the mic (getUserMedia) will only work on localhost until a cert is available`);
    return null;
  }
};
_harden(ensureEventCert);
