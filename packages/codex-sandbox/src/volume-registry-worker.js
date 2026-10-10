// @ts-check
// Private child entrypoint. Run under flock; only this lock holder writes state.
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { argv, pid, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

const [path, directory, transactionId, ownerPid, mode] = argv.slice(2);
const marker = `${directory}/transaction.json`;
const limit = 1024 * 1024;
const syncDirectory = async () => {
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};
const write = async (destination, state) => {
  const temporary = `${destination}.${randomUUID()}.new`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, destination);
    await syncDirectory();
  } finally {
    await unlink(temporary).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    });
  }
};
let previous;
try {
  previous = JSON.parse(await readFile(marker, 'utf8'));
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
    throw error;
}
if (mode === 'recover-settled' || mode === 'recover-abandoned') {
  if (mode === 'recover-abandoned' && previous !== undefined) {
    if (JSON.stringify(previous) !== argv[7])
      throw Error('Volume recovery marker changed');
    if (
      !/^[1-9][0-9]*$/.test(previous.ownerPid) ||
      !/^[0-9]+$/.test(previous.ownerStartTime)
    )
      throw Error('Unverifiable registry owner identity');
    let alive = false;
    try {
      const status = await readFile(`/proc/${previous.ownerPid}/stat`, 'utf8');
      alive =
        status.slice(status.lastIndexOf(')') + 2).split(' ')[19] ===
        previous.ownerStartTime;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    }
    if (alive) throw Error('Cannot recover a live volume registry owner');
  }
  // The parent uses this only after its own callback has completely settled.
  // New registry instances do not authorize recovery of another callback.
  if (previous !== undefined && previous.id === transactionId) {
    await unlink(marker);
    await syncDirectory();
  }
} else {
  if (previous !== undefined)
    throw Error(
      'Abandoned volume transaction requires owner reaping before recovery',
    );
  let ownerStartTime = '';
  try {
    const status = await readFile(`/proc/${ownerPid}/stat`, 'utf8');
    ownerStartTime = status.slice(status.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    /* Non-Linux worker tests do not assert process identity. */
  }
  await write(marker, {
    id: transactionId,
    ownerPid,
    ownerStartTime,
    writerPid: pid,
  });
  let state = { version: 1, nextProjectId: 1, sessions: {} };
  try {
    const bytes = await readFile(path);
    if (bytes.length > limit) throw Error('Volume registry too large');
    state = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw error;
  }
  stdout.write(`${JSON.stringify(state)}\n`);
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length > limit) throw Error('Volume registry update too large');
    const request = JSON.parse(line);
    if (request.type === 'finish') {
      await unlink(marker);
      await syncDirectory();
      stdout.write('finished\n');
      break;
    }
    if (request.type !== 'save') throw Error('Invalid volume registry request');
    await write(path, request.state);
    stdout.write('saved\n');
  }
}
