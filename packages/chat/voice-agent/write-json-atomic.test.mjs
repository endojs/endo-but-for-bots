// write-json-atomic.test.mjs — INT-1/INT-2: the shared torn-write-safe JSON store idiom. Proves:
//   (1) round-trips a value; (2) the real file is only ever replaced by an ATOMIC rename — a leftover
//   temp file from a crash-between-write-and-rename never corrupts it; (3) a GUARDED load REFUSES to
//   reset a corrupt-but-present money/authority store to {} (throws STORE_CORRUPT) instead of silently
//   wiping it; (4) a guarded load recovers from .bak when the main file is corrupt; (5) an ABSENT file
//   still returns the fallback (a genuine first boot).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, loadJson } from './write-json-atomic.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wja-'));

test('round-trips a value', () => {
  const d = tmpdir(); const f = path.join(d, 'store.json');
  writeJsonAtomic(f, { a: 1, b: [2, 3] });
  assert.deepEqual(loadJson(f), { a: 1, b: [2, 3] });
  fs.rmSync(d, { recursive: true, force: true });
});

test('the real file is untouched by a leftover temp file (crash between write and rename)', () => {
  const d = tmpdir(); const f = path.join(d, 'store.json');
  writeJsonAtomic(f, { balance: 500 });          // v1 committed
  // simulate a crash MID-WRITE: a half-written temp exists but was never renamed onto the real file.
  fs.writeFileSync(`${f}.tmp-deadbeef`, '{ "balance": 999, TORN');
  // the real file is only ever replaced by rename → still exactly v1, still parseable.
  assert.deepEqual(loadJson(f), { balance: 500 }, 'the committed value survives a torn temp write');
  fs.rmSync(d, { recursive: true, force: true });
});

test('GUARDED load refuses to reset a corrupt-but-present store (no silent {} wipe)', () => {
  const d = tmpdir(); const f = path.join(d, 'money.json');
  fs.writeFileSync(f, '{ "balance": 500, CORRUPT'); // present but unparseable, no .bak
  assert.throws(() => loadJson(f, {}, { guard: true }), e => e && e.code === 'STORE_CORRUPT', 'guarded load throws instead of returning {}');
  // an UNguarded load still tolerates it (legacy behavior) — proving the guard is what changes.
  assert.deepEqual(loadJson(f, {}), {}, 'unguarded load still returns the fallback');
  fs.rmSync(d, { recursive: true, force: true });
});

test('GUARDED load recovers the last-known-good from .bak', () => {
  const d = tmpdir(); const f = path.join(d, 'money.json');
  writeJsonAtomic(f, { balance: 100 }, { bak: true });   // no .bak yet (nothing to back up)
  writeJsonAtomic(f, { balance: 250 }, { bak: true });   // now .bak = {balance:100}
  fs.writeFileSync(f, 'GARBAGE');                          // corrupt the live file
  assert.deepEqual(loadJson(f, {}, { guard: true }), { balance: 100 }, 'falls back to the .bak copy rather than throwing');
  fs.rmSync(d, { recursive: true, force: true });
});

test('an ABSENT file returns the fallback (fresh boot), even guarded', () => {
  const d = tmpdir(); const f = path.join(d, 'never-written.json');
  assert.deepEqual(loadJson(f, { fresh: true }, { guard: true }), { fresh: true });
  fs.rmSync(d, { recursive: true, force: true });
});
