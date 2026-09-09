// @ts-check
/** @import { NodePowers } from './platform/node-powers.js' */
import harden from '@endo/harden';

/**
 * @param {NodePowers} powers
 * @param {string} path
 */
export const hashFile = async (powers, path) => {
  const { createHash } = powers.crypto;
  const { createReadStream } = powers.fs;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
harden(hashFile);

/**
 * Hold a kernel lease and pin the exact executable/bootstrap used for replay.
 * The helper cannot clean up old incarnations until compatibility is accepted.
 * @param {NodePowers} powers
 * @param {{statePath: string, workerBinary: string, bootPaths: string[], crankBudget: number, onLost: () => void}} options
 */
export const acquireIronhorseRuntime = async (
  powers,
  { statePath, workerBinary, bootPaths, crankBudget, onLost },
) => {
  const { spawn } = powers.childProcess;
  const { createHash } = powers.crypto;
  const { copyFile, mkdir, open, readFile, readdir, rename, rm } =
    powers.fsPromises;
  const { join } = powers.path;
  const { createInterface } = powers.readline;
  /** @param {string} path */
  const sync = async path => {
    const file = await open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  };

  await mkdir(statePath, { recursive: true });
  const ownerFile = await open(join(statePath, 'supervisor.lock'), 'a+', 0o600);
  let child;
  try {
    child = spawn(workerBinary, ['--lock-state', statePath], {
      stdio: ['pipe', ownerFile.fd, 'pipe'],
    });
  } catch (error) {
    await ownerFile.close();
    throw error;
  }
  let closing = false;
  let diagnostic = '';
  child.stderr?.on('data', chunk => {
    diagnostic += String(chunk);
  });
  /** @type {((error: Error) => void) | undefined} */
  let rejectWait;
  /** @type {((line: string) => void) | undefined} */
  let acceptLine;
  /** @type {string[]} */
  const queued = [];
  const lines = createInterface({
    input: /** @type {import('node:stream').Readable} */ (child.stderr),
  });
  lines.on('line', line => {
    if (acceptLine) {
      const accept = acceptLine;
      acceptLine = undefined;
      accept(line);
    } else queued.push(line);
  });
  /** @type {Error | undefined} */
  let failure;
  const exited = new Promise(resolve => {
    const fail = (/** @type {Error} */ error) => {
      failure = error;
      rejectWait?.(error);
      if (!closing) onLost();
      resolve(undefined);
    };
    child.once('error', fail);
    child.once('exit', () =>
      fail(Error(`Ironhorse ownership lost: ${diagnostic.trim()}`)),
    );
  });
  child.stdin?.on('error', error => {
    failure = error;
    rejectWait?.(error);
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
    child.stdin?.end();
    await exited;
    lines.close();
    await ownerFile.close();
  };
  try {
    const locked = JSON.parse(await receive());
    if (locked.op === 'error') throw Error(locked.message);
    if (locked.op !== 'locked') throw Error('Invalid ownership protocol');
    const hashes = await Promise.all(
      [workerBinary, ...bootPaths].map(file => hashFile(powers, file)),
    );
    const identity = {
      format: 1,
      hostProtocol: 'sequenced-hub-outbox-v1',
      worker: hashes[0],
      bootstrap: hashes.slice(1),
      crankBudget,
    };
    const profile = createHash('sha256')
      .update(JSON.stringify(identity))
      .digest('hex');
    const manifestPath = join(statePath, 'runtime.json');
    let saved;
    try {
      saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    }
    if (saved && JSON.stringify(saved) !== JSON.stringify(identity)) {
      throw Error(
        'Incompatible Ironhorse runtime: worker, bootstrap, or crank budget differs from runtime.json',
      );
    }
    if (!saved) {
      const entries = await readdir(statePath);
      const workers = await readdir(join(statePath, 'workers')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      });
      if (entries.includes('hub.json') || workers.length) {
        throw Error(
          'Unversioned Ironhorse state: no runtime.json; use the original runtime or a fresh state directory',
        );
      }
      const temporary = `${manifestPath}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(identity)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, manifestPath);
      await sync(statePath);
    }
    // Execute private, checked copies: edits to the original paths during a
    // daemon lifetime cannot silently change its next worker incarnation.
    const directory = join(statePath, 'runtime', profile);
    await mkdir(directory, { recursive: true });
    const copies = await Promise.allSettled(
      [workerBinary, ...bootPaths].map(async (source, index) => {
        const destination = join(directory, String(index));
        const temporary = `${destination}.tmp`;
        await copyFile(source, temporary);
        if ((await hashFile(powers, temporary)) !== hashes[index]) {
          await rm(temporary, { force: true });
          throw Error('Ironhorse runtime changed while being copied');
        }
        await rename(temporary, destination);
        return destination;
      }),
    );
    // Finish every copy before releasing ownership on a failed copy.
    const paths = copies.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    child.stdin?.write('prepare\n');
    if (JSON.parse(await receive()).op !== 'ready')
      throw Error('Invalid ownership prepare protocol');
    return harden({
      workerBinary: paths[0],
      bootPaths: paths.slice(1),
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
