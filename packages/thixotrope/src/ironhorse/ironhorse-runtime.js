// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { SpawnedProcess, ProcessPowers } from '../platform/processes.js' */
import { q } from '@endo/errors';
import harden from '@endo/harden';

import { assertRecordVersion } from '../store/versioned-record.js';
import { heapCeilingNames, makeIronhorseLimits } from './ironhorse-limits.js';

/**
 * @typedef {object} RuntimeIdentity
 * @property {number} format
 * @property {string} hostProtocol
 * @property {string} worker
 * @property {string[]} bootstrap
 * @property {string} [heapFormat] the heap format a worker names on its
 * `locked` line; absent for the native worker, whose format is `native`.
 * @property {[string, string][]} [parts] `[basename, sha256]` of each file
 * the worker loads from beside its executable, sorted by basename; present
 * exactly when `heapFormat` is.
 */

const heapFormatPattern = /^[a-z0-9][a-z0-9-]*$/;
const partNamePattern = /^[A-Za-z0-9._-]+$/;
const maxParts = 16;

/**
 * @param {unknown} heapFormat
 * @returns {string | undefined} what is wrong, if anything
 */
const heapFormatProblem = heapFormat => {
  if (typeof heapFormat !== 'string' || !heapFormatPattern.test(heapFormat))
    return `heapFormat ${q(heapFormat)} must match ${heapFormatPattern}`;
  // An absent heap format already means the native one.
  if (heapFormat === 'native') return 'heapFormat "native" is reserved';
  return undefined;
};

/**
 * Part copies sit beside the numbered binary and boot copies and their
 * `.tmp` siblings, so a part name must not be able to collide with either or
 * to leave the private directory.
 * @param {unknown} name
 * @returns {string | undefined} what is wrong, if anything
 */
const partNameProblem = name => {
  if (
    typeof name !== 'string' ||
    !partNamePattern.test(name) ||
    name === '.' ||
    name === '..'
  )
    return `part name ${q(name)} must be a file name matching ${partNamePattern}`;
  if (/^[0-9]+$/.test(name))
    return `part name ${q(name)} must not be all digits`;
  if (name.endsWith('.tmp')) return `part name ${q(name)} must not end in .tmp`;
  return undefined;
};

/**
 * Read the engine description a worker's lock helper may add to its `locked`
 * line: a heap format and the absolute paths of files the worker loads from
 * beside its executable. Both are absent for the native worker. Fields this
 * runtime does not know are ignored, so a newer worker may say more.
 * @param {Pick<PathPowers, 'isAbsolute' | 'basename'>} paths
 * @param {{ heapFormat?: unknown, parts?: unknown }} locked
 * @returns {{ heapFormat: string, parts: { path: string, name: string }[] } | undefined}
 */
const readLockedEngine = ({ isAbsolute, basename }, locked) => {
  const { heapFormat, parts } = locked;
  /** @param {string} problem */
  const invalid = problem =>
    Error(`Invalid ownership protocol: ${problem} in the locked message`);
  if (heapFormat === undefined && parts === undefined) return undefined;
  if (heapFormat === undefined || parts === undefined)
    throw invalid('heapFormat and parts must appear together');
  const formatProblem = heapFormatProblem(heapFormat);
  if (formatProblem) throw invalid(formatProblem);
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > maxParts)
    throw invalid(`parts must be an array of 1 to ${maxParts} paths`);
  /** @type {Set<string>} */
  const names = new Set();
  const read = parts.map(path => {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw invalid(`part ${q(path)} must be an absolute path`);
    const name = basename(path);
    const nameProblem = partNameProblem(name);
    if (nameProblem) throw invalid(nameProblem);
    if (names.has(name)) throw invalid(`part name ${q(name)} is repeated`);
    names.add(name);
    return { path, name };
  });
  return { heapFormat: /** @type {string} */ (heapFormat), parts: read };
};

/**
 * @param {HashPowers} hashes
 * @param {string} path
 */
export const hashFile = async (hashes, path) => hashes.sha256File(path);
harden(hashFile);

const incompatible =
  'Incompatible Ironhorse runtime: worker or bootstrap differs from runtime.json; use the original runtime or migrate to a fresh state directory';

/**
 * Refuse a persisted manifest this runtime cannot honor, comparing parsed
 * fields so the key order of runtime.json is irrelevant. A format above the
 * supported one or a field this runtime does not define means a newer runtime
 * wrote the manifest; that is reported as such, not as corruption. Returns the
 * persisted execution limits, validated, so the caller can tell whether the
 * manifest needs rewriting.
 * @param {any} saved parsed runtime.json
 * @param {RuntimeIdentity} identity
 * @param {Record<string, string | number>} executionLimits
 * @returns {Record<string, string | number>}
 */
const checkSavedManifest = (saved, identity, executionLimits) => {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved))
    throw Error('Invalid Ironhorse runtime.json: expected a manifest object');
  const {
    format,
    hostProtocol,
    worker,
    bootstrap,
    heapFormat,
    parts,
    limits: previous,
    ...unknownFields
  } = saved;
  assertRecordVersion('Ironhorse runtime manifest', format, identity.format);
  const [unknownField] = Object.keys(unknownFields);
  if (unknownField !== undefined) {
    throw Error(
      `Ironhorse runtime.json is from a newer version: unrecognized manifest field ${q(unknownField)}; use that runtime or migrate to a fresh state directory`,
    );
  }
  if ((heapFormat === undefined) !== (parts === undefined))
    throw Error(
      'Invalid Ironhorse runtime.json: heapFormat and parts must appear together',
    );
  if (heapFormat !== undefined) {
    const problem = heapFormatProblem(heapFormat);
    if (problem) throw Error(`Invalid Ironhorse runtime.json: ${problem}`);
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > maxParts)
      throw Error(
        `Invalid Ironhorse runtime.json: parts must be an array of 1 to ${maxParts} [name, digest] pairs`,
      );
    for (const part of parts) {
      if (
        !Array.isArray(part) ||
        part.length !== 2 ||
        typeof part[1] !== 'string'
      )
        throw Error(
          `Invalid Ironhorse runtime.json: part ${q(part)} must be a [name, digest] pair`,
        );
      const nameProblem = partNameProblem(part[0]);
      if (nameProblem)
        throw Error(`Invalid Ironhorse runtime.json: ${nameProblem}`);
    }
  }
  // Heaps of another format are unreadable whatever the code identity, so
  // that is reported first and on its own.
  const savedHeapFormat = heapFormat ?? 'native';
  const ownHeapFormat = identity.heapFormat ?? 'native';
  if (savedHeapFormat !== ownHeapFormat) {
    throw Error(
      `Incompatible Ironhorse runtime: the state directory holds ${q(savedHeapFormat)} heaps and this worker uses ${q(ownHeapFormat)} heaps; use the original worker or migrate to a fresh state directory`,
    );
  }
  /** @type {[string, string][]} */
  const savedParts = parts ?? [];
  const ownParts = identity.parts ?? [];
  if (
    hostProtocol !== identity.hostProtocol ||
    worker !== identity.worker ||
    !Array.isArray(bootstrap) ||
    bootstrap.length !== identity.bootstrap.length ||
    !bootstrap.every((digest, index) => digest === identity.bootstrap[index]) ||
    savedParts.length !== ownParts.length ||
    !savedParts.every(
      ([name, digest], index) =>
        name === ownParts[index][0] && digest === ownParts[index][1],
    )
  ) {
    throw Error(incompatible);
  }
  if (typeof previous !== 'object' || previous === null)
    throw Error('Missing Ironhorse execution limits in runtime.json');
  const unknownLimit = Object.keys(previous).find(
    name => !Object.hasOwn(executionLimits, name),
  );
  if (unknownLimit !== undefined) {
    throw Error(
      `Ironhorse runtime.json is from a newer version: unrecognized execution limit ${q(unknownLimit)}; use that runtime or migrate to a fresh state directory`,
    );
  }
  let normalized;
  try {
    normalized = makeIronhorseLimits(previous);
  } catch (error) {
    throw Error(
      `Invalid Ironhorse execution limits in runtime.json: ${/** @type {Error} */ (error).message}`,
      { cause: error },
    );
  }
  for (const name of Object.keys(executionLimits)) {
    if (previous[name] !== normalized[name]) {
      throw Error(
        `Invalid Ironhorse execution limits in runtime.json: ${name} is missing or not in canonical form`,
      );
    }
  }
  // Only the heap ceilings are monotonic: a restored arena above a lower
  // ceiling would refuse every later allocation. Refuse rather than clamp.
  for (const name of heapCeilingNames) {
    if (BigInt(executionLimits[name]) < BigInt(previous[name])) {
      throw Error(
        `Incompatible Ironhorse runtime: ${name} cannot decrease below persisted value ${previous[name]}; a restored heap may already exceed the lower ceiling`,
      );
    }
  }
  return previous;
};

/**
 * Hold a kernel lease and pin the exact executable/bootstrap used for replay.
 * The helper cannot clean up old incarnations until compatibility is accepted.
 * @param {object} powers
 * @param {ProcessPowers} powers.processes
 * @param {FilePowers} powers.files
 * @param {PathPowers} powers.paths
 * @param {HashPowers} powers.hashes
 * @param {{statePath: string, workerBinary: string, bootPaths: string[], limits: ReturnType<typeof makeIronhorseLimits>, onLost: () => void}} options
 */
export const acquireIronhorseRuntime = async (
  { processes, files, paths, hashes },
  { statePath, workerBinary, bootPaths, limits, onLost },
) => {
  const { spawn } = processes;
  const { join } = paths;
  const runtimeFiles = [workerBinary, ...bootPaths];

  await files.makeDirectory(statePath);
  const ownerFile = await files.open(
    join(statePath, 'supervisor.lock'),
    'a+',
    0o600,
  );
  /** @type {SpawnedProcess | undefined} */
  let child;
  try {
    // The helper exits when its stdin ends, which `release` arranges, or
    // when it is killed outright. A termination request is addressed to the
    // supervisor, which shuts down and then releases; were the helper to
    // honor the one a service manager's stop sends to every process in the
    // group, its exit would read as ownership lost while the supervisor was
    // still writing. Dispositions set to ignore survive `exec`, and the
    // binary forbids the unsafe code a handler would take, so a shell sets
    // them on the way in.
    child = spawn(
      '/bin/sh',
      [
        '-c',
        'trap "" TERM INT HUP; exec "$0" "$@"',
        workerBinary,
        '--lock-state',
        statePath,
      ],
      { stdio: ['pipe', ownerFile, 'pipe'] },
    );
  } catch (error) {
    await ownerFile.close();
    throw error;
  }
  let closing = false;
  let diagnostic = '';
  /** @type {((error: Error) => void) | undefined} */
  let rejectWait;
  /** @type {((line: string) => void) | undefined} */
  let acceptLine;
  /** @type {string[]} */
  const queued = [];
  /** @type {Error | undefined} */
  let failure;
  /** @param {Error} error */
  const fail = error => {
    failure = error;
    rejectWait?.(error);
    if (!closing) onLost();
  };
  void child.failed.then(error => {
    child.kill('SIGKILL');
    fail(error);
  });
  // The worker speaks one JSON message per line on stderr; accumulate each
  // line for the ownership-loss diagnostic while feeding the protocol queue.
  void (async () => {
    await null;
    try {
      for await (const line of child.lines(2)) {
        diagnostic += `${line}\n`;
        if (acceptLine) {
          const accept = acceptLine;
          acceptLine = undefined;
          accept(line);
        } else queued.push(line);
      }
    } catch (error) {
      fail(/** @type {Error} */ (error));
    }
  })();
  const exited = child.exited.then(code => {
    fail(Error(`Ironhorse ownership lost: ${diagnostic.trim()}`));
    return code;
  });
  const receive = async () => {
    if (failure) throw failure;
    if (queued.length) return queued.shift();
    return new Promise((resolve, reject) => {
      acceptLine = resolve;
      rejectWait = reject;
    });
  };
  const release = async () => {
    closing = true;
    child.input(0)?.end();
    await exited;
    await ownerFile.close();
  };
  try {
    const locked = JSON.parse(await receive());
    if (typeof locked !== 'object' || locked === null)
      throw Error('Invalid ownership protocol');
    if (locked.op === 'error') throw Error(locked.message);
    if (locked.op !== 'locked') throw Error('Invalid ownership protocol');
    const engine = readLockedEngine(paths, locked);
    const parts = engine?.parts ?? [];
    const sources = [...runtimeFiles, ...parts.map(({ path }) => path)];
    const digests = await Promise.all(
      sources.map(file => hashFile(hashes, file)),
    );
    /** @type {RuntimeIdentity} */
    const identity = {
      format: 2,
      hostProtocol: 'sequenced-hub-outbox-v1',
      worker: digests[0],
      bootstrap: digests.slice(1, runtimeFiles.length),
    };
    // The native worker's identity must stay exactly as it was, keys and
    // all, so its existing profiles and manifests still match. The format
    // stays 2 for an engine that names parts: a build that predates
    // `heapFormat` refuses such a manifest as an unrecognized field.
    if (engine) {
      identity.heapFormat = engine.heapFormat;
      // Sorted by basename in plain code-unit order (names are unique), so
      // the profile does not depend on the order the worker lists them in.
      identity.parts = parts
        .map(
          ({ name }, index) =>
            /** @type {[string, string]} */ ([
              name,
              digests[runtimeFiles.length + index],
            ]),
        )
        .sort(([a], [b]) => (a < b ? -1 : 1));
    }
    // Execution limits do not identify code or the snapshot format; keeping
    // them out of the profile lets the same heaps reopen after a change. Only
    // the heap ceilings are monotonic (see checkSavedManifest). The watchdog
    // is operational and is not part of the persisted profile at all.
    const { requestTimeoutMs: _timeout, ...executionLimits } = limits;
    const manifest = { ...identity, limits: executionLimits };
    const profile = hashes.sha256Hex(
      new TextEncoder().encode(JSON.stringify(identity)),
    );
    const manifestPath = join(statePath, 'runtime.json');
    let saved;
    try {
      saved = JSON.parse(await files.readText(manifestPath));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    }
    const previous =
      saved === undefined
        ? undefined
        : checkSavedManifest(saved, identity, executionLimits);
    if (!saved) {
      const entries = await files.listDirectory(statePath);
      const workers = await files
        .listDirectory(join(statePath, 'workers'))
        .catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return [];
        });
      if (entries.includes('hub.json') || workers.length) {
        throw Error(
          'Unversioned Ironhorse state: no runtime.json; use the original runtime or a fresh state directory',
        );
      }
    }
    // Execute private, checked copies: edits to the original paths during a
    // daemon lifetime cannot silently change its next worker incarnation.
    const directory = join(statePath, 'runtime', profile);
    await files.makeDirectory(directory);
    // Parts keep their names, so the private worker copy finds them beside
    // itself just as the original did.
    const names = [
      ...runtimeFiles.map((_, index) => String(index)),
      ...parts.map(({ name }) => name),
    ];
    const copies = await Promise.allSettled(
      sources.map(async (source, index) => {
        const destination = join(directory, names[index]);
        const temporary = `${destination}.tmp`;
        await files.copyFile(source, temporary);
        if ((await hashFile(hashes, temporary)) !== digests[index]) {
          await files.remove(temporary, { force: true });
          throw Error('Ironhorse runtime changed while being copied');
        }
        await files.rename(temporary, destination);
        return destination;
      }),
    );
    // Finish every copy before releasing ownership on a failed copy.
    const runtimePaths = copies.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    // The identity already matched; rewrite only when a limit changed.
    if (
      !previous ||
      Object.keys(executionLimits).some(
        name => previous[name] !== executionLimits[name],
      )
    ) {
      await files.writeTextAtomic(
        manifestPath,
        `${JSON.stringify(manifest)}\n`,
      );
      await files.syncPath(statePath);
    }
    child.input(0)?.write('prepare\n');
    if (JSON.parse(await receive()).op !== 'ready')
      throw Error('Invalid ownership prepare protocol');
    return harden({
      workerBinary: runtimePaths[0],
      bootPaths: runtimePaths.slice(1, runtimeFiles.length),
      profile,
      release,
      assertOwned: () => {
        if (failure || closing)
          throw Error('Ironhorse state directory is not owned');
      },
    });
  } catch (error) {
    await release();
    throw error;
  }
};
harden(acquireIronhorseRuntime);
