import fs from 'fs';
import os from 'os';
import path from 'path';

/** @import {TestRoutine} from '../_types.js' */

/**
 * @param {string} filePath
 * @param {string} expected
 */
const assertFileText = (filePath, expected) => {
  const actual = fs.readFileSync(filePath, 'utf8');
  if (actual !== expected) {
    throw Error(
      `Expected ${filePath} to contain ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

/**
 * The mount interaction verbs from `designs/daemon-mount.md` Phase 6:
 * `endo ls` and `endo cat` reach into a mount through a pet-name path, and
 * `endo write` streams stdin to a file named by path segments within a mount.
 * Every observation through the CLI is cross-checked against the backing
 * directory on disk.
 *
 * @type {TestRoutine}
 */
export const section = async (execa, testLine) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'endo-cli-mount-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}\n');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export {};\n');

  await testLine(execa`endo mount ${root} --name project`, {
    stdout: `Mounted ${root} as project`,
  });

  // `ls` lists the mount root and, through a pet-name path, a subdirectory.
  await testLine(execa`endo ls project`, {
    stdout: 'package.json\nsrc',
  });
  await testLine(execa`endo ls project/src`, {
    stdout: 'index.js',
  });

  // `cat` streams a file's bytes out of the mount.
  await testLine(execa`endo cat project/package.json`, {
    stdout: '{"name":"demo"}',
  });

  // `write` streams stdin into the mount, creating missing parents.  The
  // path may be given as separate segments or as one slash-delimited path.
  await testLine(
    execa({ input: 'first draft\n' })`endo write project notes today.txt`,
  );
  assertFileText(path.join(root, 'notes', 'today.txt'), 'first draft\n');
  await testLine(execa`endo cat project/notes/today.txt`, {
    stdout: 'first draft',
  });

  // A second write replaces the file rather than appending.
  await testLine(
    execa({ input: 'second draft\n' })`endo write project notes/today.txt`,
  );
  assertFileText(path.join(root, 'notes', 'today.txt'), 'second draft\n');

  // Bytes round-trip unchanged, including non-UTF-8 content.
  const binary = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f]);
  await execa({ input: binary })`endo write project blob.bin`;
  if (!fs.readFileSync(path.join(root, 'blob.bin')).equals(binary)) {
    throw Error('endo write did not preserve binary stdin');
  }

  // `..` is clamped at the mount root: the write lands inside the mount.
  await testLine(
    execa({ input: 'clamped\n' })`endo write project ../escape.txt`,
  );
  assertFileText(path.join(root, 'escape.txt'), 'clamped\n');
  if (fs.existsSync(path.join(root, '..', 'escape.txt'))) {
    throw Error('endo write escaped the mount root');
  }

  // A read-only mount refuses writes and leaves the disk untouched.
  await testLine(execa`endo mount ${root} --name project-ro --read-only`, {
    stdout: `Mounted ${root} as project-ro`,
  });
  const refused = await execa({
    input: 'nope\n',
    reject: false,
  })`endo write project-ro ro.txt`;
  if (refused.exitCode === 0) {
    throw Error('endo write succeeded through a read-only mount');
  }
  if (fs.existsSync(path.join(root, 'ro.txt'))) {
    throw Error('endo write wrote through a read-only mount');
  }

  fs.rmSync(root, { recursive: true, force: true });
};
