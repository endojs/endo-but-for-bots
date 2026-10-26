// @ts-check

import { q } from '@endo/errors';

/**
 * @import {
 *   GitDiff,
 *   GitDiffHunk,
 *   GitDiffLine,
 *   GitFileDiff,
 *   GitFileDiffStatus,
 * } from '@endo/exo-git';
 */

/**
 * One record of `git diff --raw -z --no-abbrev` output.
 *
 * @typedef {object} RawDiffRecord
 * @property {string} oldMode Octal mode string; `000000` when absent.
 * @property {string} newMode Octal mode string; `000000` when absent.
 * @property {string} letter Status letter without its similarity score.
 * @property {string} path The path, or the source path of a rename/copy.
 * @property {string} [destinationPath] The destination of a rename/copy.
 */

/**
 * One `diff --git` section of `git diff --patch` output, reduced to the
 * parts the raw records do not already carry.
 *
 * @typedef {object} PatchSection
 * @property {GitDiffHunk[]} hunks
 * @property {boolean} binary
 */

const ABSENT_MODE = '000000';

/** @type {ReadonlyMap<string, GitFileDiffStatus>} */
const statusByLetter = new Map([
  ['A', 'added'],
  ['C', 'copied'],
  ['D', 'deleted'],
  ['M', 'modified'],
  ['R', 'renamed'],
  // A type change (file to symlink, say) is a modification whose modes
  // differ; the patch renders it as a deletion section then an addition.
  ['T', 'modified'],
  ['U', 'unmerged'],
]);

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * @param {string} line
 * @returns {'git' | 'combined' | 'unmerged' | undefined}
 */
const sectionKind = line => {
  if (line.startsWith('diff --git ')) return 'git';
  if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
    return 'combined';
  }
  if (line.startsWith('* Unmerged path ')) return 'unmerged';
  return undefined;
};

/**
 * @param {string} rawText NUL-delimited `git diff --raw -z --no-abbrev`.
 * @returns {RawDiffRecord[]}
 */
export const parseRawDiff = rawText => {
  const fields = rawText.split('\0');
  /** @type {RawDiffRecord[]} */
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index];
    if (header === '') {
      index += 1;
    } else {
      if (!header.startsWith(':')) {
        throw Error(`Unexpected git diff --raw field ${q(header)}`);
      }
      const [oldMode, newMode, , , status] = header.slice(1).split(' ');
      const letter = status.slice(0, 1);
      const path = fields[index + 1];
      if (path === undefined || path === '') {
        throw Error(`git diff --raw record ${q(header)} names no path`);
      }
      if (letter === 'R' || letter === 'C') {
        const destinationPath = fields[index + 2];
        if (destinationPath === undefined || destinationPath === '') {
          throw Error(`git diff --raw record ${q(header)} names no target`);
        }
        records.push(
          harden({ oldMode, newMode, letter, path, destinationPath }),
        );
        index += 3;
      } else {
        records.push(harden({ oldMode, newMode, letter, path }));
        index += 2;
      }
    }
  }
  return harden(records);
};
harden(parseRawDiff);

/**
 * Split `git diff --patch` output into its `diff --git` sections, parsing
 * each hunk by its header line counts.  Combined (`diff --cc`) sections and
 * `* Unmerged path` notices describe unmerged paths, which the raw records
 * already identify, so they are consumed and dropped.
 *
 * A `\ No newline at end of file` marker is not represented in the hunk
 * lines; `diffText` keeps the full porcelain rendering.
 *
 * @param {string} patchText
 * @returns {PatchSection[]}
 */
export const parsePatchSections = patchText => {
  const lines = patchText.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  /** @type {PatchSection[]} */
  const sections = [];
  let index = 0;
  while (index < lines.length) {
    const kind = sectionKind(lines[index]);
    if (kind === undefined) {
      throw Error(`Unexpected git diff line ${q(lines[index])}`);
    }
    index += 1;
    if (kind === 'unmerged') {
      // A one-line notice with no body.
    } else if (kind === 'combined') {
      // Combined-diff body lines carry a two-column prefix, so none of them
      // can begin a new section.
      while (index < lines.length && sectionKind(lines[index]) === undefined) {
        index += 1;
      }
    } else {
      /** @type {GitDiffHunk[]} */
      const hunks = [];
      let binary = false;
      while (index < lines.length && sectionKind(lines[index]) === undefined) {
        const line = lines[index];
        const match = HUNK_HEADER.exec(line);
        if (match) {
          const oldStart = Number(match[1]);
          const oldLines = match[2] === undefined ? 1 : Number(match[2]);
          const newStart = Number(match[3]);
          const newLines = match[4] === undefined ? 1 : Number(match[4]);
          index += 1;
          let oldRemaining = oldLines;
          let newRemaining = newLines;
          /** @type {GitDiffLine[]} */
          const hunkLines = [];
          while (oldRemaining > 0 || newRemaining > 0) {
            const body = lines[index];
            if (body === undefined) {
              throw Error(`git diff hunk ${q(line)} ends early`);
            }
            const prefix = body.slice(0, 1);
            const text = body.slice(1);
            // `diff.suppressBlankEmpty` renders a blank context line as an
            // empty line rather than a lone space.
            if (prefix === ' ' || body === '') {
              hunkLines.push(harden({ kind: 'context', text }));
              oldRemaining -= 1;
              newRemaining -= 1;
            } else if (prefix === '-') {
              hunkLines.push(harden({ kind: 'remove', text }));
              oldRemaining -= 1;
            } else if (prefix === '+') {
              hunkLines.push(harden({ kind: 'add', text }));
              newRemaining -= 1;
            } else if (prefix !== '\\') {
              throw Error(`Unexpected line ${q(body)} in git diff hunk`);
            }
            if (oldRemaining < 0 || newRemaining < 0) {
              throw Error(`git diff hunk ${q(line)} overruns its counts`);
            }
            index += 1;
          }
          if (lines[index] !== undefined && lines[index].startsWith('\\')) {
            index += 1;
          }
          hunks.push(
            harden({
              oldStart,
              oldLines,
              newStart,
              newLines,
              lines: harden(hunkLines),
            }),
          );
        } else {
          if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
            binary = true;
          }
          index += 1;
        }
      }
      sections.push(harden({ hunks: harden(hunks), binary }));
    }
  }
  return harden(sections);
};
harden(parsePatchSections);

/**
 * @param {string} mode
 * @returns {number | undefined}
 */
const modeNumber = mode =>
  mode === ABSENT_MODE ? undefined : Number.parseInt(mode, 8);

/**
 * Join the two renderings of one `git diff` invocation into a `GitDiff`.
 * The raw records carry exact paths, modes, and statuses; the patch carries
 * hunks.  Both list files in the same order, which this function verifies
 * by requiring every patch section to be consumed exactly once.
 *
 * @param {string} rawText `git diff --raw -z --no-abbrev` output.
 * @param {string} patchText `git diff --patch` output for the same arguments.
 * @returns {GitDiff}
 */
export const parseGitDiff = (rawText, patchText) => {
  const records = parseRawDiff(rawText);
  const sections = parsePatchSections(patchText);
  const unmergedPaths = new Set(
    records.filter(({ letter }) => letter === 'U').map(({ path }) => path),
  );
  /** @type {GitFileDiff[]} */
  const files = [];
  let sectionIndex = 0;
  const takeSection = () => {
    const section = sections[sectionIndex];
    if (section === undefined) {
      throw Error('git diff patch output has fewer files than --raw output');
    }
    sectionIndex += 1;
    return section;
  };
  for (const record of records) {
    const status = statusByLetter.get(record.letter);
    if (status === undefined) {
      throw Error(`Unsupported git diff status ${q(record.letter)}`);
    }
    if (status === 'unmerged') {
      // Git follows an unmerged record with a stage-to-worktree record for
      // the same path and renders both as one combined section, whose
      // three-way hunks do not fit the two-sided hunk shape.
      files.push(
        harden({
          status,
          oldPath: record.path,
          newPath: record.path,
          hunks: harden([]),
        }),
      );
    } else if (!unmergedPaths.has(record.path)) {
      const section = takeSection();
      const hunks =
        record.letter === 'T'
          ? [...section.hunks, ...takeSection().hunks]
          : section.hunks;
      const oldMode = modeNumber(record.oldMode);
      const newMode = modeNumber(record.newMode);
      files.push(
        harden({
          status,
          ...(status === 'added' ? {} : { oldPath: record.path }),
          ...(status === 'deleted'
            ? {}
            : { newPath: record.destinationPath ?? record.path }),
          ...(oldMode === undefined ? {} : { oldMode }),
          ...(newMode === undefined ? {} : { newMode }),
          hunks: harden(hunks),
          ...(section.binary ? { binary: harden({}) } : {}),
        }),
      );
    }
  }
  if (sectionIndex !== sections.length) {
    throw Error('git diff patch output has more files than --raw output');
  }
  return harden({ files: harden(files) });
};
harden(parseGitDiff);
