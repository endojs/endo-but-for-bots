// component-shares.mjs — durable, least-authority share tokens for a broken-out component.
//
// A share token is NOT a cap-node: it grants exactly ONE thing — "subscribe (read-only) to this
// component's FROZEN list of declared cells" — and nothing else. It cannot open a chat, hold a power,
// or reach any cell outside its list. The owner mints it (reach-verified at mint), the recipient opens
// /c/<id>#k=<token>, and /cells/subscribe + the standalone /c/ui honour it for ONLY those cells.
//
// cap-hygiene: the plaintext token never lands on disk — only its sha256 (like purse-store). Records hold
// the component id + the cell ids + their HA handles (so the server re-resolves a read-only state reader
// lazily via haResolveReadOnly), readOnly, createdAt, revoked. Durable so a shared link survives a restart.

import crypto from 'node:crypto';
import fs from 'node:fs';

const hash = t => crypto.createHash('sha256').update(`cshare:${t}`).digest('hex');

export const makeComponentShares = ({ file }) => {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* best-effort */ } };

  // create({ componentId, cells:[{id, handle}], readOnly }) → plaintext token (shown once, then handed off)
  const create = ({ componentId, cells, readOnly = true }) => {
    const token = crypto.randomBytes(18).toString('base64url');
    data[hash(token)] = { componentId: String(componentId), cells: (cells || []).map(c => ({ id: String(c.id), handle: String(c.handle || '') })), readOnly: !!readOnly, createdAt: new Date().toISOString(), revoked: false };
    save();
    return token;
  };
  const get = token => { const r = data[hash(String(token || ''))]; return r && !r.revoked ? r : null; }; // null if unknown OR revoked
  const revoke = token => { const k = hash(String(token || '')); if (data[k]) { data[k].revoked = true; save(); return true; } return false; };
  // owner-side listing for a component (no token needed) — returns redacted records (NO token, ever)
  const listFor = componentId => Object.values(data).filter(r => r.componentId === String(componentId) && !r.revoked).map(r => ({ componentId: r.componentId, cells: r.cells.map(c => c.id), createdAt: r.createdAt }));

  return harden({ create, get, revoke, listFor });
};
harden(makeComponentShares);
