// eval-ratings.mjs — durable, owner-only record of a human RATING on a chat/eval run.
//
// A rating is the operator's verdict on a recorded run (was the agent's answer good?). It is
// owner-only: only the ROOT capability may write one (a scoped/attenuated chat cap must NOT be
// able to forge eval ground-truth — that would let a sub-agent grade its own homework). The server
// gates this on `nodeFor(cap)?.isRoot`; this module owns the on-disk shape + write so the route and
// its test exercise the SAME code path.
//
// Files land at <baseDir>/<chatId>.json, written 0600 (owner read/write only — ratings are private
// operator judgements, never world-readable). The default baseDir is the repo's eval/results/ratings.

import fs from 'node:fs';
import path from 'node:path';

// Resolve the canonical ratings directory next to this module: voice-agent/eval/results/ratings.
export const ratingsDir = (here = path.dirname(new URL(import.meta.url).pathname)) =>
  path.join(here, 'eval', 'results', 'ratings');

// A chatId must be a safe single path segment — no traversal, no separators. Keep it to a sane
// charset so the filename it becomes can never escape the ratings dir.
const safeId = id => {
  const s = String(id == null ? '' : id).trim();
  if (!s || s.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  if (s === '.' || s === '..') return null;
  return s;
};

const clampRating = r => {
  const n = Number(r);
  if (!Number.isFinite(n)) return null;
  // accept 1..5 (stars) or 0/1 (thumbs); store the number verbatim once it's in a sane range.
  if (n < 0 || n > 5) return null;
  return n;
};

// Write a rating to disk at mode 0600 and return the record + its path. Pure of any auth — the
// CALLER (the server route) must have already proven the cap is root. Throws on a bad chatId/rating.
export const writeRating = ({ chatId, rating, comment = '', by = '', dir } = {}) => {
  const id = safeId(chatId);
  if (!id) throw new Error('invalid chatId');
  const score = clampRating(rating);
  if (score === null) throw new Error('invalid rating (expected a number 0..5)');
  const baseDir = dir || ratingsDir();
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, `${id}.json`);
  const rec = {
    chatId: id,
    rating: score,
    comment: String(comment || '').slice(0, 4000),
    by: String(by || '').slice(0, 80),
    at: new Date().toISOString(),
  };
  // mode 0600: owner read/write only. Pass the mode on open so the file is created restricted from the
  // very first byte (no world-readable window before a later chmod).
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(rec, null, 2));
    // openSync's mode only applies on CREATE; if the file pre-existed its perms are unchanged, so force them.
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, path: file, rating: rec };
};

export const readRating = ({ chatId, dir } = {}) => {
  const id = safeId(chatId);
  if (!id) return null;
  const file = path.join(dir || ratingsDir(), `${id}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
