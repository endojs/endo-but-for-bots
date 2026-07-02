// write-json-atomic.mjs — the ONE torn-write-safe JSON store idiom (INT-1/INT-2).
//
// The failure it fixes: ~30 stores did `fs.writeFileSync(file, JSON.stringify(...))` in place. A crash
// (SIGKILL/OOM/power) BETWEEN the truncate and the last byte leaves a half-written file; the next boot's
// bare-catch load then silently resets the whole store to `{}` — for a MONEY/AUTHORITY store that is a
// silent balance/grant wipe. This module lifts the temp-file + rename idiom (already used ad hoc in
// bluesky-oauth/byo-store/purse-store/tool-shares) into one place, and adds:
//   • fsync of the temp file AND its directory before/after the rename, so the rename is durable across a
//     power loss (a rename can otherwise be reordered ahead of the data write on some filesystems);
//   • a `.bak` of the last-known-good file for money/authority stores;
//   • loadJsonGuarded, which — for a store that MUST NOT silently reset — REFUSES to substitute `{}` when
//     the file exists but won't parse (it throws), falling back to `.bak` first, so a corrupt byte alerts
//     loudly instead of wiping balances.
//
// rename(2) within a directory is atomic on POSIX: a reader/loader sees either the whole old file or the
// whole new one, never a torn mix. That is the guarantee callers rely on.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Best-effort fsync of a directory so a rename is durable. Not all platforms allow opening a directory for
// fsync (e.g. Windows) — swallow those; the temp+rename still gives atomicity, only the power-loss durability
// window widens.
const fsyncDir = dir => {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* platform may disallow — atomicity holds regardless */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } } }
};

// Atomically write `data` (a JSON-serializable value) to `file`. `bak:true` first copies the current file to
// `${file}.bak` (last-known-good), for money/authority stores. `pretty` uses 2-space indent. `mode` sets the
// file permission (e.g. 0o600 for secrets).
export const writeJsonAtomic = (file, data, { bak = false, pretty = false, mode } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  // keep a last-known-good copy BEFORE we touch the live file (money/authority stores).
  if (bak) { try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* best-effort */ } }
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const opts = mode == null ? undefined : { mode };
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', mode == null ? 0o666 : mode);
    fs.writeFileSync(fd, json);
    try { fs.fsyncSync(fd); } catch { /* fsync may be unsupported on some fs — rename still atomic */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
  }
  if (opts) { try { fs.chmodSync(tmp, mode); } catch { /* */ } }
  fs.renameSync(tmp, file); // atomic swap
  fsyncDir(path.dirname(file));
};
harden(writeJsonAtomic);

// Load JSON from `file`. For an ordinary store this is a convenience with a fallback default. For a
// money/authority store pass `guard:true`: if the file EXISTS but won't parse, we do NOT silently return the
// default (which would wipe balances) — we try `.bak`, and if that also fails we THROW so the operator sees
// the corruption instead of a silent reset. A genuinely ABSENT file still returns the default (first boot).
export const loadJson = (file, fallback = {}, { guard = false } = {}) => {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return fallback; throw e; } // absent = fresh store; other IO errors are real
  try { return JSON.parse(raw); }
  catch (parseErr) {
    if (!guard) return fallback; // ordinary store: tolerate a bad byte (legacy behavior)
    // GUARDED (money/authority): try the last-known-good backup before giving up.
    try { return JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')); }
    catch { /* fall through to the loud failure */ }
    const err = new Error(`refusing to reset ${path.basename(file)}: it exists but won't parse and no usable .bak — ${(parseErr && parseErr.message) || parseErr}`);
    err.code = 'STORE_CORRUPT';
    throw err;
  }
};
harden(loadJson);
