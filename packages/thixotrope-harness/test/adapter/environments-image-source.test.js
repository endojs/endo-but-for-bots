// @ts-check
// Workspace images (`resources/environments/impl/image-source.js`; contract
// `designs/m6-interfaces.md` 3.4 "openImage", seam X-1, acceptance 21,
// section 11): the adapter-side `ImageSource` over a worktree file, called
// through M8's `ImageSource` guard as M8's image tool calls it.
import test from '@endo/ses-ava/test.js';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { makeWorkspaceFixture } from './_environments-git.js';

/* eslint-disable import/no-relative-packages */
import { environmentTexts } from '../../guest/lib/guards/environments.js';
import { imageLimits } from '../../guest/lib/guards/images.js';
import { imageMethodNames, imageTexts } from '../../guest/lib/image-guards.js';
/* eslint-enable import/no-relative-packages */
import { openImage } from '../../resources/environments/impl/image-source.js';

const { E } = /** @type {any} */ (globalThis);
const T = environmentTexts;

/**
 * The fixture and an `openImage` over it, with a withdrawn switch.
 * @param {any} t
 */
const makeImages = async t => {
  const fixture = await makeWorkspaceFixture(t);
  /** @type {boolean | string} */
  let withdrawn = false;
  /** @param {unknown} segments */
  const open = segments =>
    openImage({
      key: fixture.key,
      segments,
      dirsOf: fixture.dirsOf,
      isWithdrawn: () => withdrawn,
    });
  /** @param {boolean | string} value */
  const withdraw = value => {
    withdrawn = value;
  };
  return { fixture, open, withdraw };
};

/**
 * Read a source page by page as M8's tool does, through the guard.
 * @param {any} source
 * @param {number} pageBytes
 */
const readAll = async (source, pageBytes) => {
  /** @type {Buffer[]} */
  const pages = [];
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { data, done } = await E(source).readBase64(
      harden({ offset, maxBytes: pageBytes }),
    );
    const bytes = Buffer.from(data, 'base64');
    pages.push(bytes);
    offset += bytes.length;
    if (done) break;
  }
  return { bytes: Buffer.concat(pages), pages: pages.length };
};

test('pages reassemble the file; size is the file size; pages are clamped to the guard', async t => {
  const { fixture, open } = await makeImages(t);
  const image = randomBytes(500_000);
  await fixture.write('img/a.png', image);
  const source = await open(['img', 'a.png']);
  t.deepEqual(
    // eslint-disable-next-line no-underscore-dangle
    [...(await E(source).__getMethodNames__())]
      .filter((/** @type {string} */ name) => !name.startsWith('__'))
      .sort(),
    [...imageMethodNames.ImageSource].sort(),
  );
  t.is(await E(source).size(), image.length);
  const full = await readAll(source, imageLimits.readPageBytes);
  t.true(full.bytes.equals(image));
  t.is(full.pages, 3);
  // An exec-vat caller's small pages.
  const small = await readAll(source, 12_288);
  t.true(small.bytes.equals(image));
  // More than a page asked: one page answered.
  const big = await E(source).readBase64(
    harden({ offset: 0, maxBytes: 10_000_000 }),
  );
  t.is(Buffer.from(big.data, 'base64').length, imageLimits.readPageBytes);
  t.false(big.done);
  // Past the end: empty and done.
  t.deepEqual(
    await E(source).readBase64(harden({ offset: 600_000, maxBytes: 10 })),
    { data: '', done: true },
  );
  // The guard refuses a malformed range.
  await t.throwsAsync(
    E(source).readBase64(harden({ offset: -1, maxBytes: 10 })),
  );
  await t.throwsAsync(E(source).readBase64(harden({ offset: 0 })));
});

test('a file changed between reads is read as it is; a symlink swapped in is refused', async t => {
  const { fixture, open } = await makeImages(t);
  await fixture.write('a.png', Buffer.alloc(100, 1));
  const source = await open(['a.png']);
  t.is(await E(source).size(), 100);
  await fixture.write('a.png', Buffer.alloc(300, 2));
  t.is(await E(source).size(), 300);
  const page = await E(source).readBase64(harden({ offset: 0, maxBytes: 10 }));
  t.true(Buffer.from(page.data, 'base64').equals(Buffer.alloc(10, 2)));
  const secret = join(fixture.root, 'secret');
  await writeFile(secret, 'not yours');
  await rm(join(fixture.workspace, 'a.png'));
  await symlink(secret, join(fixture.workspace, 'a.png'));
  await t.throwsAsync(
    E(source).readBase64(harden({ offset: 0, maxBytes: 10 })),
    { message: T.gitPathRefused },
  );
  await t.throwsAsync(E(source).size(), { message: T.gitPathRefused });
  // A directory component swapped for a symlink is refused too.
  await mkdir(join(fixture.workspace, 'img'));
  await fixture.write('img/b.png', Buffer.alloc(5));
  const nested = await open(['img', 'b.png']);
  await mkdir(join(fixture.root, 'elsewhere'));
  await writeFile(join(fixture.root, 'elsewhere', 'b.png'), 'outside');
  await rm(join(fixture.workspace, 'img'), { recursive: true });
  await symlink(
    join(fixture.root, 'elsewhere'),
    join(fixture.workspace, 'img'),
  );
  await t.throwsAsync(E(nested).size(), { message: T.gitPathRefused });
});

test('paths: .., .git, a symlink out, a directory, a FIFO are refused; missing is not found', async t => {
  const { fixture, open } = await makeImages(t);
  for (const segments of [
    ['..', 'x'],
    ['.git', 'config'],
    ['.Git', 'HEAD'],
    ['a', '.', 'b'],
    ['a/b'],
    [''],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(open(segments), { message: T.gitPathRefused });
  }
  // Over M8's path bounds: the guard refuses before any file system call.
  await t.throwsAsync(open(Array.from({ length: 65 }, () => 'a')));
  await t.throwsAsync(open(['a'.repeat(256)]));
  await t.throwsAsync(open('a.png'));
  const outside = join(fixture.root, 'outside.png');
  await writeFile(outside, 'x');
  await symlink(outside, join(fixture.workspace, 'out.png'));
  await t.throwsAsync(open(['out.png']), { message: T.gitPathRefused });
  await mkdir(join(fixture.workspace, 'dir.png'));
  await t.throwsAsync(open(['dir.png']), { message: T.gitPathRefused });
  execFileSync('mkfifo', [join(fixture.workspace, 'pipe.png')]);
  await t.throwsAsync(open(['pipe.png']), { message: T.gitPathRefused });
  await t.throwsAsync(open(['missing.png']), { message: imageTexts.notFound });
  await t.throwsAsync(open(['no', 'such.png']), {
    message: imageTexts.notFound,
  });
});

test('a large file answers its size and reads only the pages asked', async t => {
  const { fixture, open } = await makeImages(t);
  const { open: openFile } = await import('node:fs/promises');
  const handle = await openFile(join(fixture.workspace, 'huge.png'), 'w');
  await handle.truncate(1024 * 1024 * 1024);
  await handle.close();
  const source = await open(['huge.png']);
  t.is(await E(source).size(), 1024 * 1024 * 1024);
  const page = await E(source).readBase64(
    harden({ offset: 512 * 1024 * 1024, maxBytes: 1000 }),
  );
  t.is(Buffer.from(page.data, 'base64').length, 1000);
  t.false(page.done);
});

test('a withdrawn or released key refuses a source opened before', async t => {
  const { fixture, open, withdraw } = await makeImages(t);
  await fixture.write('a.png', Buffer.alloc(10));
  const source = await open(['a.png']);
  withdraw(true);
  await t.throwsAsync(E(source).size(), { message: T.stopped });
  await t.throwsAsync(
    E(source).readBase64(harden({ offset: 0, maxBytes: 10 })),
    { message: T.stopped },
  );
  await t.throwsAsync(open(['a.png']), { message: T.stopped });
  withdraw(T.released);
  await t.throwsAsync(E(source).size(), { message: T.released });
  withdraw(false);
  t.is(await E(source).size(), 10);
});
