// @ts-check
/**
 * Helpers for the "no secret value in the state directory" checks (M2
 * W2.3; acceptance 7; `designs/m2-interfaces.md` 9.2). W2.3's adapter test
 * uses them over an adapter-only state directory; W2.9's
 * `m2-secrets.test.js` uses them over a whole daemon state directory after
 * the end-to-end exercise.
 *
 * The public-branch rule: no test value may look like a credential in the
 * source, so `makeTestSecretValue` builds the value at run time (words with
 * spaces plus random hex, unique per run so a hit cannot be an old file).
 *
 * `grepState` reads every regular file under a root (heaps and their SQLite
 * snapshots, worker journals, `hub-image.json`, `hub-log.jsonl`, blobs, the
 * archive, `secrets.enc`, logs) and looks for the needle in each encoding a
 * value could take there: UTF-8 (JSON, logs, blobs), UTF-16LE and UTF-16BE
 * (strings in a heap snapshot are UTF-16), and base64 and base64url at all
 * three byte alignments (worker journals keep frames in base64). Pass a
 * `control` text that the exercise is known to have put in the state (a
 * label, a prompt) and assert it IS found: that proves the grep can see
 * the encoding a heap or journal uses, so "not found" means something.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A secret value for tests, built at run time.
 * @param {string} [tag]
 */
export const makeTestSecretValue = (tag = 'value') =>
  ['not', 'a', 'real', tag, randomBytes(8).toString('hex')].join(' ');

/**
 * The base64 text that the bytes of `bytes` produce wherever they sit in a
 * longer encoded stream, for each of the three alignments: the first and
 * last groups (which depend on neighbouring bytes) are cut.
 * @param {Buffer} bytes
 */
const base64Cores = bytes => {
  /** @type {string[]} */
  const cores = [];
  for (let shift = 0; shift < 3; shift += 1) {
    const text = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const start = shift === 0 ? 0 : 4;
    const end =
      (shift + bytes.length) % 3 === 0 ? text.length : text.length - 4;
    const core = text.slice(start, end).replace(/=+$/, '');
    if (core.length >= 8) cores.push(core);
  }
  return cores;
};

/**
 * Every byte pattern `text` can take in the state directory.
 * @param {string} text
 * @returns {{ encoding: string, bytes: Buffer }[]}
 */
export const encodingsOf = text => {
  const utf8 = Buffer.from(text, 'utf8');
  const utf16le = Buffer.from(text, 'utf16le');
  const utf16be = Buffer.from(utf16le).swap16();
  const out = [
    { encoding: 'utf8', bytes: utf8 },
    { encoding: 'utf16le', bytes: utf16le },
    { encoding: 'utf16be', bytes: utf16be },
  ];
  for (const core of base64Cores(utf8)) {
    out.push({ encoding: 'base64', bytes: Buffer.from(core, 'ascii') });
    const url = core.replace(/\+/g, '-').replace(/\//g, '_');
    if (url !== core)
      out.push({ encoding: 'base64url', bytes: Buffer.from(url, 'ascii') });
  }
  return out;
};

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Where `needle` appears under `root`, in any encoding of `encodingsOf`.
 * @param {string} root
 * @param {string} needle
 * @returns {Promise<{ file: string, encoding: string }[]>}
 */
export const grepState = async (root, needle) => {
  const patterns = encodingsOf(needle);
  /** @type {{ file: string, encoding: string }[]} */
  const hits = [];
  let files = 0;
  let bytes = 0;
  for await (const file of filesUnder(root)) {
    // A file may vanish while a daemon runs (temp files); skip it.
    const data = await readFile(file).catch(() => undefined);
    if (data !== undefined) {
      files += 1;
      bytes += data.length;
      for (const { encoding, bytes: pattern } of patterns) {
        if (data.includes(pattern)) hits.push({ file, encoding });
      }
    }
  }
  return Object.assign(hits, { files, bytes });
};

/**
 * Assert that `value` is nowhere under `root` and `control` is.
 * @param {import('ava').ExecutionContext} t
 * @param {string} root
 * @param {{ value: string, control?: string }} needles
 */
export const assertNoSecretInState = async (t, root, { value, control }) => {
  const hits = await grepState(root, value);
  t.deepEqual(
    hits.map(({ file, encoding }) => `${file} (${encoding})`),
    [],
    'no encoding of the secret value under the state directory',
  );
  if (control !== undefined) {
    const seen = await grepState(root, control);
    t.true(
      seen.length > 0,
      'the control text is found, so the grep reads these files',
    );
  }
  return hits;
};
