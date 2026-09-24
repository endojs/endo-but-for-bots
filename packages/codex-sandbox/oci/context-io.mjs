// @ts-check
// SANDBOX ONLY. Never import this to read guest-controlled paths from the host.
// Parent realpath checks catch static mistakes, not directory replacement races;
// the existing sandbox mounts, not these checks, provide filesystem confinement.
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  renderCodexNativeContext,
  selectCodexNativeContext,
} from './native-context.mjs';

const LIMIT = 16 * 1024 * 1024;
const requireValue = condition => {
  if (!condition) throw Error('Invalid Codex native capture');
};
const uuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const absolute = value =>
  typeof value === 'string' &&
  path.isAbsolute(value) &&
  value === path.resolve(value) &&
  !value.includes('\0');
const beneath = (child, parent) => child.startsWith(`${parent}${path.sep}`);

/**
 * Read one explicitly named rollout inside an already isolated sandbox.
 * No discovery, ambient newest-session selection, or host filesystem authority.
 * Call after the requested turn has completed; concurrent mutation is unsupported.
 * @param {{root: string, cwd: string, rolloutPath: string, sessionId: string, turnId: string, cliVersion: string}} expected
 */
export const captureCodexContext = async expected => {
  const { root, cwd, rolloutPath, sessionId, turnId, cliVersion } = expected;
  requireValue(
    absolute(root) &&
      root !== path.parse(root).root &&
      absolute(cwd) &&
      absolute(rolloutPath) &&
      uuid(sessionId) &&
      uuid(turnId) &&
      cliVersion === '0.152.0',
  );
  const sessions = path.join(root, 'sessions');
  requireValue(beneath(rolloutPath, sessions));
  requireValue(
    new RegExp(
      `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${sessionId}\\.jsonl$`,
    ).test(path.basename(rolloutPath)),
  );
  const canonicalRoot = await realpath(root);
  const canonicalSessions = await realpath(sessions);
  const canonicalParent = await realpath(path.dirname(rolloutPath));
  requireValue(
    beneath(canonicalSessions, canonicalRoot) &&
      (canonicalParent === canonicalSessions ||
        beneath(canonicalParent, canonicalSessions)),
  );
  requireValue(
    typeof constants.O_NOFOLLOW === 'number' &&
      typeof constants.O_NONBLOCK === 'number',
  );
  const file = await open(
    path.join(canonicalParent, path.basename(rolloutPath)),
    // OS open flags are a bit mask, not arithmetic options.
    // eslint-disable-next-line no-bitwise
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    requireValue(before.isFile() && before.size <= BigInt(LIMIT));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = new Uint8Array(64 * 1024);
    let bytes = 0;
    let text = '';
    for (;;) {
      // The loop is deliberately sequential on one descriptor.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      requireValue(bytes <= LIMIT);
      text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
    text += decoder.decode();
    const after = await file.stat({ bigint: true });
    requireValue(
      before.size === BigInt(bytes) &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
    );
    return selectCodexNativeContext(text, {
      sessionId,
      turnId,
      cwd,
      cliVersion,
    });
  } finally {
    await file.close();
  }
};
if (typeof harden === 'function') harden(captureCodexContext);

/**
 * Publish a disposable native projection without replacing an existing path.
 * The journal remains its durable source. Run only inside the model sandbox.
 * @param {{root: string, capture: Parameters<typeof renderCodexNativeContext>[0], target: Parameters<typeof renderCodexNativeContext>[1]}} request
 */
export const restoreCodexContext = async ({ root, capture, target }) => {
  // Validate all data before any directory or file creation.
  const { sessionId, transcript } = renderCodexNativeContext(capture, target);
  requireValue(absolute(root) && root !== path.parse(root).root);
  const canonicalRoot = await realpath(root);
  const segments = ['sessions', ...target.timestamp.slice(0, 10).split('-')];
  let parent = canonicalRoot;
  for (const segment of segments) {
    const next = path.join(parent, segment);
    // Check each existing parent before descending: detect static symlink
    // escapes without claiming this confines directory replacement races.
    // eslint-disable-next-line no-await-in-loop
    await mkdir(next, { recursive: true, mode: 0o700 });
    // eslint-disable-next-line no-await-in-loop
    const canonical = await realpath(next);
    requireValue(beneath(canonical, parent));
    parent = canonical;
  }
  const stamp = target.timestamp.slice(0, 19).replaceAll(':', '-');
  const filename = `rollout-${stamp}-${sessionId}.jsonl`;
  const destination = path.join(parent, filename);
  const temporary = path.join(parent, `.endo-context-${randomUUID()}`);
  // Do not clean a name unless this invocation exclusively created it.
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(transcript, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // A hard link publishes complete bytes atomically and refuses both an
    // existing file and a symlink. Rename would overwrite either destination.
    await link(temporary, destination);
  } finally {
    await unlink(temporary);
  }
  return Object.freeze({
    sessionId,
    rolloutPath: path.join(root, ...segments, filename),
    sha256: createHash('sha256').update(transcript).digest('hex'),
  });
};
if (typeof harden === 'function') harden(restoreCodexContext);
