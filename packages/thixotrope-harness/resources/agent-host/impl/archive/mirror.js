// @ts-check
/**
 * `mirror.jsonl`: the session's kept records as the adapter received them
 * (M2 W2.8; `designs/m2-interfaces.md` 4.7). One line
 * `{ "i": <absolute index>, "r": <keyed record> }` per record, appended at
 * every request without an fsync (a cache: a torn or stale mirror is
 * detected and the tail is paged from the vat instead), rewritten from
 * `sealedTo` (temp file and rename) once a seal is acknowledged.
 *
 * A seal (A1) reads its range from here instead of paging the records out
 * of the vat again, and a context rebuild after a restart reads its tail
 * from here plus one gap page (4.8).
 *
 * Node only.
 */
import {
  appendFile,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';

/**
 * @param {number} from
 * @param {readonly any[]} records keyed records
 */
const linesOf = (from, records) => {
  if (records.length === 0) return '';
  /** @type {string[]} */
  const lines = [];
  records.forEach((record, k) => {
    lines.push(JSON.stringify({ i: from + k, r: record }));
  });
  return `${lines.join('\n')}\n`;
};

/**
 * Append records `from`.. (no fsync).
 * @param {string} path
 * @param {number} from
 * @param {readonly any[]} records keyed records
 */
export const appendMirror = async (path, from, records) => {
  if (records.length === 0) return;
  await appendFile(path, linesOf(from, records), { mode: 0o600 });
};
harden(appendMirror);

/**
 * Replace the mirror by records `from`.. (temp file and rename).
 * @param {string} path
 * @param {number} from
 * @param {readonly any[]} records keyed records
 */
export const rewriteMirror = async (path, from, records) => {
  const temp = `${path}.tmp`;
  await writeFile(temp, linesOf(from, records), { mode: 0o600 });
  await rename(temp, path);
};
harden(rewriteMirror);

/**
 * The mirror's contiguous run of records: from its first line while each
 * line parses and names the next index. A torn last line (no fsync) ends the
 * run. Records below `from` are skipped; at most up to `until` (exclusive).
 *
 * @param {string} path
 * @param {{ from?: number, until?: number }} [range]
 * @returns {Promise<{ from: number, records: any[] }>} `from` is the index
 *   of `records[0]` (or of where the run would start when empty)
 */
export const loadMirror = async (
  path,
  { from = 0, until = Number.MAX_SAFE_INTEGER } = {},
) => {
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { from, records: [] };
  }
  /** @type {any[]} */
  const records = [];
  let start = -1;
  let expect = -1;
  for (const line of text.split('\n')) {
    if (line === '') break;
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      break;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Number.isSafeInteger(parsed.i) ||
      typeof parsed.r !== 'object'
    ) {
      break;
    }
    const index = Number(parsed.i);
    if (expect >= 0 && index !== expect) break;
    expect = index + 1;
    if (index >= until) break;
    if (index >= from) {
      if (start < 0) start = index;
      records.push(parsed.r);
    }
  }
  return { from: start < 0 ? from : start, records };
};
harden(loadMirror);

/** @param {string} path */
export const removeMirror = path => unlink(path).catch(() => {});
harden(removeMirror);
