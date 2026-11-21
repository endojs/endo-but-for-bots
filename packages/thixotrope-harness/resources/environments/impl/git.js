// @ts-check
/**
 * Host-side git over a session's workspace (contract
 * `designs/m6-interfaces.md` D-M6-7, 3.4, 4.3, 5.2; spec P-19, R3-40,
 * R3-246..R3-248): every operation the manager forwards through
 * `EnvironmentsOps.git(key, { op, args })`, one at a time per workspace,
 * each answered as a closed record of `environmentShapes` cut to
 * `environmentLimits.answerBytes`.
 *
 * The workspace is also the container's `/workspace`: the container writes
 * the same `.git`. Before every operation (reads too) the repository's
 * shape is checked (`.git` a real directory, no alternates, no common-dir
 * redirect) and `@endo/git`'s native backend refuses repository config
 * that could run a program on the host (filter and merge drivers,
 * includes: `gitConfigRefused`); every git process runs with that
 * backend's neutralising arguments and environment (hooks, fsmonitor,
 * attributes file, signing, credential helpers off; no global or system
 * config). Writes go through the backend; reads whose answer the backend
 * does not shape (porcelain letters, oids per branch, capped subjects)
 * run git directly with the same arguments, their output capped while it
 * is read (a 1 MiB commit subject never reaches a buffer whole).
 *
 * Branch names are checked by git's ref-name rules before git sees them;
 * revisions by a narrower rule (a ref name with `~n`/`^n` suffixes, or an
 * object id); paths are relative, may not leave the worktree or name
 * `.git` (any case: a case-insensitive file system aliases `.GIT`).
 * A failure rejects with git's first line of stderr, bounded, with the
 * workspace's host path replaced by `/workspace` (D-M6-14).
 *
 * `openWorkspaceFile` is the one way this adapter reads a worktree file
 * (`read` here, `ImageSource` in `./image-source.js`): every component
 * checked with `lstat` (no symlink followed), the file opened with
 * `O_NOFOLLOW | O_NONBLOCK` (a FIFO cannot hang it), required to be a
 * regular file, and re-checked against its real path after opening.
 *
 * Node only (adapter). State: one backend and one queue tail per key,
 * dropped by `forget(key)` (release) and the queue entry when it settles.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  internalHelpers,
  makeNativeGitBackend,
} from '@endo/git/src/native-git-backend.js';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentLimits,
  environmentShapes,
  environmentTexts,
  gitOps,
} from '../../../guest/lib/guards/environments.js';
import { fitsFrame } from '../../../guest/lib/bounded.js';
import { limits } from '../../../guest/lib/limits.js';
import { shapes as sessionShapes } from '../../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */

/** @import { FileHandle } from 'node:fs/promises' */

const { mustMatch } = /** @type {any} */ (globalThis);

const L = environmentLimits;
const T = environmentTexts;

// `@endo/git`'s own neutralising arguments and environment, so a direct
// read runs exactly as the backend's calls do (imported, not copied).
const { GIT_BASE_ARGS, GIT_TIMEOUT_MS, makeGitEnv } = internalHelpers;

/** Operations that change the repository (refused for a reader's calls). */
export const gitWriteOps = harden([
  'add',
  'restore',
  'commit',
  'createBranch',
  'switchBranch',
  'renameBranch',
  'deleteBranch',
  'merge',
  'stashPush',
  'stashPop',
]);

/** The commit every new workspace starts from (contract 4.2). */
export const initialCommitMessage = 'Initialize workspace';

/** Fae `readSources`: bytes of a file scanned at most. */
const SCAN_BYTES = 1024 * 1024;
/** Output kept from one direct git read (status of a huge tree, a diff). */
const READ_CAP_BYTES = 4 * 1024 * 1024;
const DIFF_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
/** The rejection of `read` for a path that names nothing. */
const MISSING = 'No such file in the workspace';

const utf8 = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------- checks

/** @param {string} message */
const refuse = message => {
  throw Error(message);
};

/**
 * One relative path segment: nonempty, no separator or NUL, not `.`,
 * `..` or `.git` in any letter case.
 * @param {unknown} segment
 */
const segmentAllowed = segment =>
  typeof segment === 'string' &&
  segment.length > 0 &&
  !/[/\\\0]/.test(segment) &&
  segment !== '.' &&
  segment !== '..' &&
  segment.toLowerCase() !== '.git';

/**
 * A path as segments (`read`, `openImage`), or refuse with
 * `gitPathRefused`.
 * @param {unknown} segments
 * @param {number} [maxSegments]
 * @returns {string[]}
 */
export const checkSegments = (
  segments,
  maxSegments = limits.readSourcesPathSegments,
) => {
  if (
    !Array.isArray(segments) ||
    segments.length < 1 ||
    segments.length > maxSegments ||
    !segments.every(segmentAllowed)
  )
    refuse(T.gitPathRefused);
  return /** @type {string[]} */ (segments);
};
harden(checkSegments);

/**
 * A path as git takes it (`a/b/c`, relative to the worktree root), or
 * refuse with `gitPathRefused`. A trailing `/` names a directory.
 * @param {unknown} path
 */
export const checkGitPath = path => {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > L.gitPathUnits ||
    path.startsWith('/')
  )
    refuse(T.gitPathRefused);
  const segments = /** @type {string} */ (path).replace(/\/$/, '').split('/');
  if (!segments.every(segmentAllowed)) refuse(T.gitPathRefused);
  return /** @type {string} */ (path);
};
harden(checkGitPath);

/**
 * Git's ref-name rules (`git check-ref-format --branch`), in process: no
 * leading `-`, not `HEAD`, no component starting with `.` or ending in
 * `.lock`, no `..`, `@{`, `//`, control character, space or any of
 * `~ ^ : ? * [ \`, not ending in `/` or `.`, not `@`.
 * @param {unknown} name
 */
const isBranchName = name =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= L.gitRefUnits &&
  !name.startsWith('-') &&
  name !== 'HEAD' &&
  name !== '@' &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000- \u007f~^:?*[\\]/.test(name) &&
  !name.includes('..') &&
  !name.includes('@{') &&
  !name.includes('//') &&
  !name.startsWith('/') &&
  !name.endsWith('/') &&
  !name.endsWith('.') &&
  name
    .split('/')
    .every(part => !part.startsWith('.') && !part.endsWith('.lock'));

/**
 * A branch name, or refuse with `gitRefRefused`.
 * @param {unknown} name
 */
export const checkBranchName = name => {
  if (!isBranchName(name)) refuse(T.gitRefRefused);
  return /** @type {string} */ (name);
};
harden(checkBranchName);

/**
 * A revision: `HEAD` or a branch name, optionally followed by `~n` / `^n`
 * steps, or an object id (hex); else refuse with `gitRefRefused`.
 * @param {unknown} revision
 */
export const checkRevision = revision => {
  if (typeof revision !== 'string' || revision.length > L.gitRefUnits)
    refuse(T.gitRefRefused);
  const text = /** @type {string} */ (revision);
  const base = text.replace(/(?:[~^][0-9]*)+$/, '');
  if (base !== 'HEAD' && !isBranchName(base) && !/^[0-9a-f]{4,64}$/.test(base))
    refuse(T.gitRefRefused);
  return text;
};
harden(checkRevision);

// ---------------------------------------------------------------- texts

/**
 * A git failure as the reason a vat may see: the first line of git's own
 * message (after the backend's `git x failed` header), host paths of the
 * environment replaced, bounded to `reasonUnits`.
 * @param {unknown} error
 * @param {string[]} hostPaths the workspace (and its real path) first
 */
const reasonOf = (error, hostPaths) => {
  const message =
    error instanceof Error ? error.message : String(error ?? 'git failed');
  const lines = message.split('\n').filter(line => line.trim() !== '');
  const line =
    lines.length > 1 && /^git \S+ failed/.test(lines[0]) ? lines[1] : lines[0];
  let reason = (line ?? 'git failed').trim();
  for (const path of hostPaths) {
    reason = reason.split(path).join('/workspace');
  }
  for (const path of hostPaths) {
    // Anything above the workspace (the environment's own directory).
    reason = reason.split(dirname(path)).join('/environment');
  }
  return reason.slice(0, limits.reasonUnits);
};

/** @param {unknown} error */
const isConfigRefusal = error =>
  error instanceof Error &&
  /Refusing git operation because repository config can execute commands/.test(
    error.message,
  );

/** @param {unknown} error */
const isIdentityFailure = error =>
  error instanceof Error &&
  /repository identity changed|root mismatch/.test(error.message);

/**
 * Cut text to `units` UTF-16 units without splitting a surrogate pair.
 * @param {string} text
 * @param {number} units
 */
const cutUnits = (text, units) => {
  if (text.length <= units) return text;
  let end = units;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
};

/**
 * The longest prefix length `n` in `[0, max]` with `fits(n)` (monotone).
 * @param {number} max
 * @param {(n: number) => boolean} fits
 */
const longestFitting = (max, fits) => {
  if (fits(max)) return max;
  let lo = 0;
  let hi = max;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
};

/** @param {unknown} answer */
const fitsAnswer = answer => fitsFrame(answer, L.answerBytes);

// ---------------------------------------------------------------- processes

/**
 * Run git in `cwd` with the backend's arguments and environment, keeping
 * at most `maxBytes` of stdout (then the process is stopped and `cut` is
 * true). A non-zero exit without a cut rejects with git's stderr.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBytes?: number, okCodes?: number[] }} [options]
 * @returns {Promise<{ stdout: string, cut: boolean, code: number | null }>}
 */
const runGitCapped = (
  cwd,
  args,
  { maxBytes = READ_CAP_BYTES, okCodes = [0] } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_BASE_ARGS, ...args], {
      cwd,
      // A fresh extensible object: Node may add coverage variables to it.
      env: { ...makeGitEnv(cwd) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const chunks = [];
    let kept = 0;
    let cut = false;
    /** @type {Buffer[]} */
    const errors = [];
    let errorBytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      if (cut) return;
      const room = maxBytes - kept;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept = maxBytes;
        cut = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      if (errorBytes >= STDERR_CAP_BYTES) return;
      errors.push(chunk);
      errorBytes += chunk.length;
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      const stdout = utf8.decode(Buffer.concat(chunks));
      if (cut || okCodes.includes(/** @type {number} */ (code))) {
        resolve({ stdout, cut, code });
        return;
      }
      const stderr = utf8.decode(Buffer.concat(errors)).trim();
      reject(
        Error(`git ${args[0]} failed (exit ${code}):\n${stderr || stdout}`),
      );
    });
  });

/**
 * Make `workspace` a repository on branch `main` with one empty commit
 * (contract 4.2), as the backend's environment would. For the layout's
 * `ensureWorkspace` and tests; the caller writes the ready marker after.
 * @param {string} workspace an existing, empty directory
 * @param {{bundle: string, commit: string}} [seed] trusted local project bundle
 */
export const initWorkspaceRepository = async (workspace, seed) => {
  await runGitCapped(workspace, ['init', '--quiet', '--initial-branch=main']);
  if (seed !== undefined) {
    // Import into this repository's object store. A bundle has no local
    // transports, remote configuration, alternates, or checkout hooks.
    const { stdout } = await runGitCapped(workspace, [
      'bundle',
      'unbundle',
      seed.bundle,
    ]);
    if (!stdout.split('\n').includes(`${seed.commit} refs/heads/seed`))
      throw Error('Workspace seed ref does not match the configured commit');
    const object = await runGitCapped(workspace, [
      'cat-file',
      '-t',
      seed.commit,
    ]);
    if (object.stdout.trim() !== 'commit')
      throw Error('Workspace seed ref must be a commit');
    await runGitCapped(workspace, ['reset', '--hard', '--quiet', seed.commit]);
    return;
  }
  await runGitCapped(workspace, [
    'commit',
    '--quiet',
    '--allow-empty',
    '--no-verify',
    '-m',
    initialCommitMessage,
  ]);
};
harden(initWorkspaceRepository);

// ---------------------------------------------------------------- files

/**
 * Open a worktree file for reading under the path rules: every directory
 * component a real directory (`lstat`), the file itself opened without
 * following a symlink and without blocking, a regular file, and still the
 * file its checked path names after the open (real path and inode). A
 * refusal rejects with `gitPathRefused`; a missing file with `missing`.
 * @param {string} workspace
 * @param {string[]} segments already checked by `checkSegments`
 * @param {string} missing the text for a path that names nothing
 * @returns {Promise<{ handle: FileHandle, size: number }>}
 */
export const openWorkspaceFile = async (workspace, segments, missing) => {
  /** @param {any} error */
  const absent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  let root;
  try {
    root = await realpath(workspace);
  } catch (error) {
    if (absent(error)) refuse(missing);
    throw error;
  }
  let at = root;
  for (const segment of segments.slice(0, -1)) {
    at = join(at, segment);
    // eslint-disable-next-line no-await-in-loop
    const info = await lstat(at).catch(error => {
      if (absent(error)) refuse(missing);
      throw error;
    });
    if (!info.isDirectory()) refuse(T.gitPathRefused);
  }
  const target = join(root, ...segments);
  /** @type {FileHandle} */
  let handle;
  try {
    handle = await open(
      target,
      // eslint-disable-next-line no-bitwise
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (absent(error)) refuse(missing);
    refuse(T.gitPathRefused);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) refuse(T.gitPathRefused);
    const real = await realpath(target);
    if (real !== target) refuse(T.gitPathRefused);
    const named = await stat(real);
    if (named.ino !== info.ino || named.dev !== info.dev)
      refuse(T.gitPathRefused);
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
harden(openWorkspaceFile);

/**
 * `SourceReader.read` over the worktree (M5's protocol, Fae's rules): the
 * first 1 MiB of the file, lines from `startLine`, at most `lineCount`
 * lines and `readSourcesItemUnits` characters, `search` literal; then cut
 * to the answer bound.
 * @param {string} workspace
 * @param {{ path: string[], startLine?: number, lineCount?: number, search?: string }} request
 */
const readSource = async (workspace, request) => {
  const {
    path,
    startLine = 1,
    lineCount = limits.readSourcesDefaultLines,
    search,
  } = request;
  let opened;
  try {
    opened = await openWorkspaceFile(workspace, checkSegments(path), MISSING);
  } catch (error) {
    // A missing file rejects: `readSources` answers its unreadable text.
    if (/** @type {Error} */ (error).message === MISSING) throw error;
    return harden({ ok: false, error: /** @type {Error} */ (error).message });
  }
  const { handle, size } = opened;
  let text;
  try {
    const want = Math.min(size, SCAN_BYTES);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, 0);
    text = utf8.decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  const scanTruncated = size > SCAN_BYTES;
  const source = text.split('\n');
  /** @type {{ line: number, text: string }[]} */
  const lines = [];
  let characters = 0;
  let outputTruncated = false;
  for (let at = startLine - 1; at < source.length; at += 1) {
    const line = source[at];
    // eslint-disable-next-line no-continue
    if (search !== undefined && !line.includes(search)) continue;
    if (
      lines.length === lineCount ||
      characters === limits.readSourcesItemUnits
    ) {
      outputTruncated = true;
      break;
    }
    const rendered = cutUnits(line, limits.readSourcesItemUnits - characters);
    characters += rendered.length;
    lines.push({ line: at + 1, text: rendered });
    if (rendered.length < line.length) outputTruncated = true;
  }
  /** @param {number} n */
  const resultOf = n =>
    harden({
      ok: true,
      lines: lines.slice(0, n),
      scanTruncated,
      outputTruncated: outputTruncated || n < lines.length,
    });
  return resultOf(longestFitting(lines.length, n => fitsAnswer(resultOf(n))));
};

// ---------------------------------------------------------------- answers

/**
 * Parse `git status --porcelain=v2 -z --branch` into a `GitStatus`.
 * @param {string} out
 * @param {boolean} cut
 * @param {number} limit
 */
const statusOf = (out, cut, limit) => {
  const fields = out.split('\0');
  // A cut stream ends inside a record: drop the partial one.
  if (cut) fields.pop();
  /** @type {string | null} */
  let branch = null;
  /** @type {{ path: string, index: string, worktree: string, from?: string }[]} */
  const entries = [];
  let truncated = cut;
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    if (field.startsWith('# branch.head ')) {
      const name = field.slice('# branch.head '.length);
      branch = name === '(detached)' || !isBranchName(name) ? null : name;
    } else if (field.startsWith('1 ') || field.startsWith('2 ')) {
      const parts = field.split(' ');
      const kind = parts[0];
      const xy = parts[1];
      const path = parts.slice(kind === '1' ? 8 : 9).join(' ');
      /** @type {{ path: string, index: string, worktree: string, from?: string }} */
      const entry = { path, index: xy[0], worktree: xy[1] };
      if (kind === '2') {
        at += 1;
        entry.from = fields[at];
      }
      entries.push(entry);
    } else if (field.startsWith('u ')) {
      const parts = field.split(' ');
      entries.push({
        path: parts.slice(10).join(' '),
        index: parts[1][0],
        worktree: parts[1][1],
      });
    } else if (field.startsWith('? ')) {
      entries.push({ path: field.slice(2), index: '?', worktree: '?' });
    }
  }
  const within = entries.filter(
    entry =>
      entry.path.length <= L.gitPathUnits &&
      (entry.from === undefined || entry.from.length <= L.gitPathUnits),
  );
  if (within.length < entries.length) truncated = true;
  const chosen = within;
  const max = Math.min(chosen.length, limit);
  if (max < chosen.length) truncated = true;
  /** @param {number} n */
  const answerOf = n =>
    harden({
      branch,
      entries: chosen.slice(0, n).map(entry => harden(entry)),
      truncated: truncated || n < chosen.length,
    });
  return answerOf(longestFitting(max, n => fitsAnswer(answerOf(n))));
};

/**
 * @param {string} value
 * @param {number} units
 */
const field = (value, units) => cutUnits(value.trimEnd(), units);

// ---------------------------------------------------------------- the module

/**
 * @typedef {object} WorkspaceDirs
 * @property {string} workspace the repository root (the container's `/workspace`)
 */

/**
 * @param {object} powers
 * @param {(key: string) => WorkspaceDirs} powers.dirsOf
 * @param {(key: string) => Promise<void>} powers.ensureWorkspace
 * @param {typeof makeNativeGitBackend} [powers.makeBackend]
 */
export const makeWorkspaceGit = ({
  dirsOf,
  ensureWorkspace,
  makeBackend = makeNativeGitBackend,
}) => {
  /** @type {Map<string, ReturnType<typeof makeNativeGitBackend>>} */
  const backends = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  /**
   * The key's operations one after another; the entry goes when the last
   * one settles.
   * @template R
   * @param {string} key
   * @param {() => Promise<R>} work
   * @returns {Promise<R>}
   */
  const serially = (key, work) => {
    const before = tails.get(key) ?? Promise.resolve();
    const result = before.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };

  /**
   * The structural checks git's config check cannot make: `.git` is a
   * directory of this worktree (not a symlink or a `gitdir:` file naming
   * another repository), and borrows no objects or common directory from
   * elsewhere.
   * @param {string} workspace
   */
  const checkRepositoryShape = async workspace => {
    const dotGit = join(workspace, '.git');
    const info = await lstat(dotGit).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) refuse(T.gitConfigRefused);
    for (const borrowed of [
      'commondir',
      join('objects', 'info', 'alternates'),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const found = await lstat(join(dotGit, borrowed)).catch(() => undefined);
      if (found !== undefined) refuse(T.gitConfigRefused);
    }
  };

  /**
   * The key's backend, checked: identity and the executable-config
   * refusal. The container may rewrite `.git/config` (a legitimate
   * `git config` too), which the backend reads as an identity change: the
   * backend is then made again once over the same directory, which checks
   * the worktree root afresh.
   * @param {string} key
   * @param {string} workspace
   */
  const checkedBackend = async (key, workspace) => {
    await checkRepositoryShape(workspace);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let backend = backends.get(key);
      if (backend === undefined) {
        backend = makeBackend({ repoRoot: workspace });
        backends.set(key, backend);
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await backend.assertNoExecutableRepoConfig();
        return backend;
      } catch (error) {
        backends.delete(key);
        if (isConfigRefusal(error)) refuse(T.gitConfigRefused);
        if (!isIdentityFailure(error)) throw error;
      }
    }
    return refuse(T.gitConfigRefused);
  };

  /** @param {string} workspace */
  const currentBranch = async workspace => {
    const { stdout, code } = await runGitCapped(
      workspace,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { okCodes: [0, 1] },
    );
    const name = stdout.trim();
    return code === 0 && isBranchName(name) ? name : null;
  };

  /** @param {string} workspace */
  const headOid = async workspace => {
    const { stdout, code } = await runGitCapped(
      workspace,
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      { okCodes: [0, 1] },
    );
    const oid = stdout.trim();
    return code === 0 && /^[0-9a-f]{4,64}$/.test(oid) ? oid : null;
  };

  /**
   * @param {string} workspace
   * @param {{ conflicts?: string[] }} [extra]
   */
  const writeResult = async (workspace, extra = {}) =>
    harden({
      branch: await currentBranch(workspace),
      head: await headOid(workspace),
      ...extra,
    });

  /** @param {string} workspace */
  const conflictsOf = async workspace => {
    const { stdout } = await runGitCapped(workspace, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
    ]);
    return stdout
      .split('\0')
      .filter(path => path !== '' && path.length <= L.gitPathUnits)
      .slice(0, L.maxGitPaths);
  };

  /** @type {Record<string, (workspace: string, backend: any, args: any[]) => Promise<any>>} */
  const operations = {
    status: async (workspace, _backend, [options = {}]) => {
      const paths =
        options.paths === undefined
          ? undefined
          : options.paths.map(checkGitPath);
      const { stdout, cut } = await runGitCapped(workspace, [
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        `--untracked-files=${options.untracked ?? 'normal'}`,
        ...(paths === undefined ? [] : ['--', ...paths]),
      ]);
      return statusOf(stdout, cut, options.limit ?? L.gitStatusEntries);
    },
    diff: async (workspace, _backend, [options = {}]) => {
      /** @type {string[]} */
      const revisions = [options.from, options.to]
        .filter(revision => revision !== undefined)
        .map(checkRevision);
      /** @type {string[]} */
      const paths = (options.paths ?? []).map(checkGitPath);
      const { stdout, cut } = await runGitCapped(
        workspace,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          ...(options.staged ? ['--cached'] : []),
          ...(options.stat ? ['--stat'] : []),
          ...(revisions.length > 0 ? ['--end-of-options', ...revisions] : []),
          ...(paths.length > 0 ? ['--', ...paths] : []),
        ],
        { maxBytes: DIFF_CAP_BYTES },
      );
      const textCut = cutUnits(stdout, L.gitTextUnits);
      return harden({
        text: textCut,
        truncated: cut || textCut.length < stdout.length,
      });
    },
    log: async (workspace, _backend, [options = {}]) => {
      const limit = Math.max(1, options.limit ?? L.gitLogEntries);
      const start = checkRevision(options.after ?? options.from ?? 'HEAD');
      const { stdout, cut } = await runGitCapped(workspace, [
        'log',
        '--no-show-signature',
        `--format=%H%x00%<(${L.gitSubjectUnits},trunc)%s%x00%<(${L.gitAuthorUnits},trunc)%an%x00%ct%x00`,
        `--max-count=${limit + 1}`,
        ...(options.since === undefined ? [] : [`--since=@${options.since}`]),
        ...(options.until === undefined ? [] : [`--until=@${options.until}`]),
        '--end-of-options',
        start,
      ]);
      // `H\0s\0an\0ct\0` then a newline per commit; the final field is the
      // last newline. A cut stream loses its last, partial record.
      const fields = stdout.split('\0');
      const records = Math.max(
        0,
        Math.floor((fields.length - 1) / 4) - (cut ? 1 : 0),
      );
      /** @type {{ oid: string, subject: string, author: string, time: number }[]} */
      const commits = [];
      for (let record = 0; record < records; record += 1) {
        const [oid, subject, author, time] = fields.slice(
          record * 4,
          record * 4 + 4,
        );
        commits.push(
          harden({
            oid: oid.trim(),
            subject: field(subject, L.gitSubjectUnits),
            author: field(author, L.gitAuthorUnits),
            time: Number.parseInt(time, 10) || 0,
          }),
        );
      }
      const more = commits.length > limit;
      const page = commits.slice(0, limit);
      /** @param {number} n */
      const answerOf = n => {
        const next = n < commits.length ? commits[n].oid : undefined;
        return harden({
          commits: page.slice(0, n),
          truncated: cut || n < page.length,
          ...(next === undefined ? {} : { next }),
        });
      };
      const answer = answerOf(
        longestFitting(page.length, n => fitsAnswer(answerOf(n))),
      );
      return more || answer.commits.length < page.length
        ? answer
        : harden({ commits: answer.commits, truncated: answer.truncated });
    },
    branches: async workspace => {
      const { stdout } = await runGitCapped(workspace, [
        'for-each-ref',
        `--count=${L.gitBranchEntries + 1}`,
        '--format=%(HEAD)%00%(objectname)%00%(refname:short)',
        'refs/heads/',
      ]);
      const rows = stdout.split('\n').filter(line => line !== '');
      const branches = rows
        .map(line => line.split('\0'))
        .filter(
          ([, oid, name]) => isBranchName(name) && oid.length <= L.oidUnits,
        )
        .map(([head, oid, name]) =>
          harden({ name, current: head === '*', oid }),
        );
      const kept = branches.slice(0, L.gitBranchEntries);
      return harden({
        branches: kept,
        truncated: kept.length < rows.length,
      });
    },
    currentBranch: async workspace => currentBranch(workspace),
    // R3-248: a session workspace has no upstream.
    trackingStatus: async workspace => {
      const branch = await currentBranch(workspace);
      return harden({
        branch,
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: branch === null && (await headOid(workspace)) !== null,
      });
    },
    stashList: async workspace => {
      const { stdout } = await runGitCapped(workspace, [
        'stash',
        'list',
        `--max-count=${L.gitStashEntries + 1}`,
        `--format=%<(${L.gitSubjectUnits},trunc)%gs%x00`,
      ]);
      const messages = stdout
        .split('\0')
        .map(text => text.replace(/^\n/, ''))
        .filter((text, at, all) => at < all.length - 1 || text !== '');
      const kept = messages.slice(0, L.gitStashEntries);
      return harden({
        stashes: kept.map((message, index) =>
          harden({ index, message: field(message, L.gitSubjectUnits) }),
        ),
        truncated: kept.length < messages.length,
      });
    },
    read: async (workspace, _backend, [request]) =>
      readSource(workspace, request),
    add: async (workspace, backend, [paths]) => {
      await backend.add(paths.map(checkGitPath));
      return writeResult(workspace);
    },
    restore: async (workspace, backend, [paths, options = {}]) => {
      await backend.restore(paths.map(checkGitPath), {
        staged: options.staged === true,
      });
      return writeResult(workspace);
    },
    commit: async (workspace, backend, [message]) => {
      await backend.commit(message);
      return writeResult(workspace);
    },
    createBranch: async (workspace, backend, [name, options = {}]) => {
      await backend.createBranch(checkBranchName(name), {
        ...(options.startPoint === undefined
          ? {}
          : { startPoint: checkRevision(options.startPoint) }),
        switchAfterCreate: options.switchAfterCreate === true,
      });
      return writeResult(workspace);
    },
    switchBranch: async (workspace, backend, [name]) => {
      await backend.switchBranch(checkBranchName(name));
      return writeResult(workspace);
    },
    renameBranch: async (workspace, backend, [from, to]) => {
      await backend.renameBranch(checkBranchName(from), checkBranchName(to));
      return writeResult(workspace);
    },
    deleteBranch: async (workspace, backend, [name, options = {}]) => {
      await backend.deleteBranch(checkBranchName(name), {
        force: options.force === true,
      });
      return writeResult(workspace);
    },
    merge: async (workspace, backend, [name, options = {}]) => {
      const revision = checkRevision(name);
      try {
        if (options.mode === 'merge-commit' && options.message !== undefined) {
          // The backend's merge takes no message; the config check above
          // ran for this operation.
          await runGitCapped(workspace, [
            'merge',
            '--no-ff',
            '-m',
            options.message,
            '--end-of-options',
            revision,
          ]);
        } else {
          await backend.merge(
            revision,
            options.mode === 'merge-commit'
              ? { noFastForward: true }
              : { fastForwardOnly: true },
          );
        }
      } catch (error) {
        const conflicts = await conflictsOf(workspace);
        if (conflicts.length === 0) throw error;
        return writeResult(workspace, { conflicts });
      }
      return writeResult(workspace);
    },
    stashPush: async (workspace, backend, [message]) => {
      await backend.stashPush(message === undefined ? {} : { message });
      return writeResult(workspace);
    },
    stashPop: async (workspace, backend) => {
      await backend.stashPop();
      return writeResult(workspace);
    },
  };

  /** The argument shapes per operation (the adapter checks again). */
  const S = environmentShapes;
  /** @type {Record<string, () => any[]>} */
  const argumentShapes = {
    status: () => [S.GitStatusRequest],
    diff: () => [S.GitDiffRequest],
    log: () => [S.GitLogRequest],
    branches: () => [],
    currentBranch: () => [],
    trackingStatus: () => [],
    stashList: () => [],
    read: () => [sessionShapes.SourceReadRequest],
    add: () => [S.GitPaths],
    restore: () => [S.GitPaths, S.GitRestoreOptions],
    commit: () => [S.GitMessage],
    createBranch: () => [S.GitRef, S.GitCreateBranchOptions],
    switchBranch: () => [S.GitRef],
    renameBranch: () => [S.GitRef, S.GitRef],
    deleteBranch: () => [S.GitRef, S.GitDeleteBranchOptions],
    merge: () => [S.GitRef, S.GitMergeOptions],
    stashPush: () => [S.GitMessage],
    stashPop: () => [],
  };

  /**
   * One operation on the key's workspace.
   * @param {string} key
   * @param {{ op: string, args: any[] }} request
   * @param {{ readOnly?: boolean }} [options]
   */
  const run = (key, { op, args = [] }, { readOnly = false } = {}) => {
    if (!gitOps.includes(op))
      return Promise.reject(Error(`unknown git op ${op}`));
    if (readOnly && gitWriteOps.includes(op))
      return Promise.reject(Error(T.gitReadOnly));
    const shapes = argumentShapes[op]();
    if (args.length > shapes.length)
      return Promise.reject(Error(`git ${op}: too many arguments`));
    try {
      args.forEach((arg, at) => {
        if (arg !== undefined) mustMatch(harden(arg), shapes[at], op);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return serially(key, async () => {
      await ensureWorkspace(key);
      const { workspace } = dirsOf(key);
      const hostPaths = [workspace];
      try {
        hostPaths.unshift(await realpath(workspace));
        const backend = await checkedBackend(key, workspace);
        return await operations[op](workspace, backend, args);
      } catch (error) {
        // No cause: it may carry host paths (D-M6-14).
        // eslint-disable-next-line preserve-caught-error
        throw Error(reasonOf(error, hostPaths));
      }
    });
  };

  /**
   * Remove a stale `.git/index.lock` a killed git left (contract 4.7: the
   * bind's sweep, before anything of this key runs again). Only a regular
   * file is removed.
   * @param {string} key
   */
  const removeStaleLock = key =>
    serially(key, async () => {
      const lock = join(dirsOf(key).workspace, '.git', 'index.lock');
      const info = await lstat(lock).catch(() => undefined);
      if (info === undefined || !info.isFile()) return false;
      await rm(lock, { force: true });
      return true;
    });

  /**
   * Drop what this module keeps for a key (its release).
   * @param {string} key
   */
  const forget = key => {
    backends.delete(key);
  };

  return harden({ run, removeStaleLock, forget });
};
harden(makeWorkspaceGit);
