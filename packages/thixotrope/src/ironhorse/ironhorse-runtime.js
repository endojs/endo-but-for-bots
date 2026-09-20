// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { ChildProcessPowers, ProcessPowers } from '../platform/processes.js' */
import harden from '@endo/harden';

import { makeIronhorseLimits } from './ironhorse-limits.js';

/**
 * @param {HashPowers} hashes
 * @param {string} path
 */
export const hashFile = async (hashes, path) => hashes.sha256File(path);
harden(hashFile);

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

  await files.makeDirectory(statePath);
  const ownerFile = await files.open(
    join(statePath, 'supervisor.lock'),
    'a+',
    0o600,
  );
  /** @type {ChildProcessPowers | undefined} */
  let child;
  try {
    child = spawn(workerBinary, ['--lock-state', statePath], {
      stdio: ['pipe', ownerFile, 'pipe'],
    });
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
    if (locked.op === 'error') throw Error(locked.message);
    if (locked.op !== 'locked') throw Error('Invalid ownership protocol');
    const digests = await Promise.all(
      [workerBinary, ...bootPaths].map(file => hashFile(hashes, file)),
    );
    const identity = {
      format: 2,
      hostProtocol: 'sequenced-hub-outbox-v1',
      worker: digests[0],
      bootstrap: digests.slice(1),
    };
    // Execution ceilings may only increase. They do not identify code or the
    // snapshot format; retaining the profile allows the same heaps to reopen.
    // The watchdog is operational and can change in either direction.
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
    if (saved) {
      const { limits: previous, ...savedIdentity } = saved;
      if (JSON.stringify(savedIdentity) !== JSON.stringify(identity)) {
        throw Error(
          'Incompatible Ironhorse runtime: worker, bootstrap, or manifest format differs from runtime.json; use the original runtime or migrate to a fresh state directory',
        );
      }
      if (!previous)
        throw Error('Missing Ironhorse execution limits in runtime.json');
      const { requestTimeoutMs: _previousTimeout, ...normalized } =
        makeIronhorseLimits(previous);
      if (JSON.stringify(previous) !== JSON.stringify(normalized))
        throw Error('Invalid Ironhorse execution limits in runtime.json');
      for (const name of Object.keys(executionLimits)) {
        if (BigInt(executionLimits[name]) < BigInt(previous[name])) {
          throw Error(
            `Incompatible Ironhorse runtime: ${name} cannot decrease below persisted value ${previous[name]}`,
          );
        }
      }
    }
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
    const copies = await Promise.allSettled(
      [workerBinary, ...bootPaths].map(async (source, index) => {
        const destination = join(directory, String(index));
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
    if (JSON.stringify(saved) !== JSON.stringify(manifest)) {
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
      bootPaths: runtimePaths.slice(1),
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
