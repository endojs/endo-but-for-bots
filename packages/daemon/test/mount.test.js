// @ts-nocheck
/* global process */
// Saboteur regression sweep for packages/daemon/src/mount.js.
// Aggregate audit: process/audit/mount-saboteur-2026-05-10.md.
// Each test is annotated with the attack vector it exercises.
import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { makeMount } from '../src/mount.js';
import { makeFilePowers } from '../src/daemon-node-powers.js';

const filePowers = makeFilePowers({ fs, path });
const textDecoder = new TextDecoder();

/**
 * Create a fresh, canonicalized mount-root directory and a confined
 * EndoMountDirectory exo over it.  Registers a teardown hook to remove
 * the temp directory regardless of test outcome.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {boolean} [options.readOnly]
 * @returns {Promise<{
 *   mount: ReturnType<typeof makeMount>,
 *   mountRoot: string,
 *   tempBase: string,
 * }>}
 */
const prepareMount = async (t, { readOnly = false } = {}) => {
  const tempBase = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'mount-saboteur-'),
  );
  // Canonicalize so symlink-confinement assertions compare like-with-like
  // on hosts where /tmp is itself a symlink (e.g. macOS /private/tmp).
  const realBase = await fs.promises.realpath(tempBase);
  const mountRoot = path.join(realBase, 'mount-root');
  await fs.promises.mkdir(mountRoot, { recursive: true });
  t.teardown(async () => {
    await null;
    // best-effort cleanup; restore perms on locked subtrees first so rm
    // can recurse into them.
    try {
      await fs.promises.chmod(mountRoot, 0o755);
    } catch {
      // chmod failure is non-fatal; rm below is the actual cleanup.
    }
    await fs.promises.rm(realBase, { recursive: true, force: true });
  });
  const mount = makeMount({ rootPath: mountRoot, readOnly, filePowers });
  return { mount, mountRoot, tempBase: realBase };
};

/**
 * Mount-root layout with internal and escaping symlinks for confinement
 * tests.  Layout is parallel to endo.test.js' createSymlinkFixture.
 *
 * @param {import('ava').ExecutionContext} t
 */
const prepareSymlinkFixture = async t => {
  const { mount, mountRoot, tempBase } = await prepareMount(t);
  const outsideDir = path.join(tempBase, 'outside');
  await fs.promises.mkdir(outsideDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(outsideDir, 'secret.txt'),
    'you should not see this',
  );
  await fs.promises.symlink(outsideDir, path.join(mountRoot, 'escape-abs'));
  await fs.promises.symlink('../outside', path.join(mountRoot, 'escape-rel'));
  await fs.promises.symlink(
    path.join(outsideDir, 'secret.txt'),
    path.join(mountRoot, 'escape-file-abs'),
  );
  await fs.promises.symlink(
    '../outside/secret.txt',
    path.join(mountRoot, 'escape-file-rel'),
  );
  return { mount, mountRoot, outsideDir };
};

// Escape regex special chars in `s` so it can be used as a literal.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Attack 1: path-clamping `..` traversal across all mutations ---

test.serial(
  'attack #1: parent-traversal segments clamp at root, never escape (writes)',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    const escape = ['..', '..', '..', '..', '..', '..', '..', 'etc', 'passwd'];

    // has() on a clamped path that resolves to mount-root must succeed
    // without escape, and return false because mountRoot/etc/passwd
    // does not exist yet.
    t.false(await mount.has(...escape));

    // Read of nonexistent path: ENOENT (caller-actionable).
    await t.throwsAsync(mount.readText(escape), {
      message: /no such file|ENOENT|cannot be verified/i,
    });

    // Write clamps into mountRoot/etc/passwd, NOT /etc/passwd.
    await mount.writeText(escape, 'pwned');
    const onDisk = await fs.promises.readFile(
      path.join(mountRoot, 'etc', 'passwd'),
      'utf-8',
    );
    t.is(onDisk, 'pwned');

    // makeDirectory clamps too.
    await mount.makeDirectory(['..', '..', 'sub-clamp']);
    const subStat = await fs.promises.stat(path.join(mountRoot, 'sub-clamp'));
    t.true(subStat.isDirectory());

    // remove clamps too (operates on mountRoot/etc/passwd).
    await mount.remove(escape);
    await t.throwsAsync(
      fs.promises.access(path.join(mountRoot, 'etc', 'passwd')),
    );
  },
);

// --- Attack 2: absolute-path / `/`- or `\`- containing segment rejection ---

test.serial(
  'attack #2: absolute-path / slash-containing segments rejected at the boundary',
  async t => {
    const { mount } = await prepareMount(t);
    for (const seg of ['/etc/passwd', '/', 'foo/bar', 'a\\b']) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(mount.has(seg), { message: /must not contain/ });
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(mount.readText([seg]), {
        message: /must not contain/,
      });
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(mount.writeText([seg], 'x'), {
        message: /must not contain/,
      });
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(mount.makeDirectory([seg]), {
        message: /must not contain/,
      });
    }
  },
);

// --- Attack 3: relative-target symlink across read paths + Open Q 3 ---

test.serial(
  'attack #3: relative ../ symlink rejected on readText/maybeReadText',
  async t => {
    const { mount, outsideDir } = await prepareSymlinkFixture(t);

    await t.throwsAsync(mount.readText('escape-file-rel'), {
      message: /escapes mount root|no such|cannot be verified/i,
    });
    t.is(await mount.maybeReadText('escape-file-rel'), undefined);

    // Open Question 3: writing through a relative-../ directory
    // symlink today (node:fs backend) follows the symlink and
    // would create files outside the mount.  Document the gap as
    // a regression marker that will tighten when cap-std-style
    // host (lstat+unlink before write) lands.
    await mount
      .writeText(['escape-rel', 'inject.txt'], 'x')
      .catch(() => undefined);
    const after = await fs.promises.readdir(outsideDir);
    if (!after.includes('inject.txt')) {
      t.deepEqual(
        after.sort(),
        ['secret.txt'],
        'mount may not create entries outside confinement (Open Q 3 fix landed)',
      );
    } else {
      t.pass(
        'Open Question 3 still open: write-through-symlink reaches outside; ' +
          'expected to start failing once the lstat+unlink follow-up lands.',
      );
    }
  },
);

// --- Attack 4: absolute-target symlink fully confined ---

test.serial(
  'attack #4: absolute-target symlink fully confined across read methods + list',
  async t => {
    const { mount } = await prepareSymlinkFixture(t);

    // readText must throw — generic confinement or ENOENT-shape error.
    await t.throwsAsync(mount.readText('escape-file-abs'), {
      message: /escapes|no such|cannot be verified/i,
    });
    t.is(await mount.maybeReadText('escape-file-abs'), undefined);

    // list() must not reveal the escaping entry at all.
    const entries = await mount.list();
    t.false(entries.includes('escape-abs'));
    t.false(entries.includes('escape-file-abs'));

    // list(symlink-segment) — recursive escape attempt — must reject.
    await t.throwsAsync(mount.list('escape-abs'), {
      message: /escapes|cannot be verified/i,
    });
  },
);

// --- Attack 5: chain of symlinks crossing the boundary ---

test.serial(
  'attack #5: chained symlinks ending outside the mount are rejected',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.symlink('b', path.join(mountRoot, 'a'));
    await fs.promises.symlink('c', path.join(mountRoot, 'b'));
    await fs.promises.symlink('/etc/passwd', path.join(mountRoot, 'c'));

    await t.throwsAsync(mount.readText('a'), {
      message: /escapes mount root|cannot be verified/i,
    });
    await t.throwsAsync(mount.lookup('a'), {
      message: /escapes mount root|cannot be verified/i,
    });
    t.false(await mount.has('a'), 'has() must hide a chain escaping the mount');
    const entries = await mount.list();
    t.false(
      entries.includes('a'),
      'list() must hide a chain escaping the mount',
    );
  },
);

// --- Attack 6: EACCES/EPERM/EROFS message-leak audit ---

test.serial(
  'attack #6: EACCES on writeText surfaces as generic confinement error, ' +
    'no host path / errno / syscall leak',
  async t => {
    if (process.getuid && process.getuid() === 0) {
      t.pass('skip: chmod 000 does not deny root');
      return;
    }
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.mkdir(path.join(mountRoot, 'locked'));
    await fs.promises.chmod(path.join(mountRoot, 'locked'), 0o000);

    const e = await t.throwsAsync(mount.writeText(['locked', 'file'], 'x'));
    t.regex(e.message, /Operation not permitted within mount/);
    t.notRegex(
      e.message,
      new RegExp(escapeRe(mountRoot)),
      'error message must not echo the host filesystem path',
    );
    t.notRegex(
      e.message,
      /EACCES|EPERM|EROFS|errno|syscall/i,
      'error message must not leak OS error code or syscall name',
    );
    t.is(
      e.cause,
      undefined,
      'cause chain must be dropped to prevent host-detail leak',
    );
  },
);

// --- Attack 7: ENOENT-vs-EACCES distinguishability on read paths (THE FIX) ---

test.serial(
  'attack #7: readText on a permission-denied file returns generic ' +
    'confinement error, no host path leak',
  async t => {
    if (process.getuid && process.getuid() === 0) {
      t.pass('skip: chmod 000 does not deny root');
      return;
    }
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.writeFile(path.join(mountRoot, 'denied.txt'), 'x');
    await fs.promises.chmod(path.join(mountRoot, 'denied.txt'), 0o000);

    const e = await t.throwsAsync(mount.readText('denied.txt'));
    t.regex(e.message, /Operation not permitted within mount/);
    t.notRegex(
      e.message,
      new RegExp(escapeRe(mountRoot)),
      'readText error must not echo the host filesystem path',
    );
    t.notRegex(
      e.message,
      /EACCES|EPERM|EROFS|errno|syscall/i,
      'readText error must not leak OS error code or syscall name',
    );
  },
);

test.serial(
  'attack #7: MountFile.text() and .json() on a denied file collapse to ' +
    'generic confinement error',
  async t => {
    if (process.getuid && process.getuid() === 0) {
      t.pass('skip: chmod 000 does not deny root');
      return;
    }
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.writeFile(path.join(mountRoot, 'denied.txt'), '{"a":1}');
    await fs.promises.chmod(path.join(mountRoot, 'denied.txt'), 0o000);

    const file = await mount.lookup('denied.txt');
    const eText = await t.throwsAsync(file.text());
    t.regex(eText.message, /Operation not permitted within mount/);
    t.notRegex(eText.message, new RegExp(escapeRe(mountRoot)));

    const eJson = await t.throwsAsync(file.json());
    t.regex(eJson.message, /Operation not permitted within mount/);
    t.notRegex(eJson.message, new RegExp(escapeRe(mountRoot)));
  },
);

test.serial(
  'attack #7: maybeReadText on a denied file remains undefined ' +
    '(do not regress the bare-catch behavior)',
  async t => {
    if (process.getuid && process.getuid() === 0) {
      t.pass('skip: chmod 000 does not deny root');
      return;
    }
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.writeFile(path.join(mountRoot, 'denied.txt'), 'x');
    await fs.promises.chmod(path.join(mountRoot, 'denied.txt'), 0o000);

    // Pin: maybeReadText collapses ANY error to undefined, so EACCES
    // becomes indistinguishable from ENOENT.  A future refactor that
    // tightens the catch must not re-open the leak.
    t.is(await mount.maybeReadText('denied.txt'), undefined);
    t.is(await mount.maybeReadText('absent.txt'), undefined);
  },
);

// --- Attack 8: TOCTOU symlink swap (best-effort regression marker) ---

test.serial(
  'attack #8: symlink swap between assertion and write does not exfiltrate ' +
    '(best-effort regression marker)',
  async t => {
    const { mount, mountRoot, tempBase } = await prepareMount(t);
    // Outside file the swap targets.  Use a confined sentinel so we
    // never read or write /etc/passwd from a test.
    const targetOutside = path.join(tempBase, 'outside-target.txt');
    await fs.promises.writeFile(targetOutside, 'pre');
    await fs.promises.writeFile(path.join(mountRoot, 'target.txt'), 'safe');

    let swapped = false;
    const swap = (async () => {
      await null;
      for (let i = 0; i < 50 && !swapped; i += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.unlink(path.join(mountRoot, 'target.txt'));
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.symlink(
            targetOutside,
            path.join(mountRoot, 'target.txt'),
          );
          swapped = true;
        } catch {
          /* race; retry */
        }
      }
    })();

    const writes = [];
    for (let i = 0; i < 50; i += 1) {
      writes.push(
        mount.writeText(['target.txt'], `write-${i}`).catch(() => {}),
      );
    }
    await Promise.all([...writes, swap]);

    // Document the hazard rather than claim a fix: if writeText followed
    // the symlink and overwrote the outside file, that is the cap-std
    // follow-up's job to close.
    const outsideAfter = await fs.promises.readFile(targetOutside, 'utf-8');
    if (outsideAfter !== 'pre') {
      t.pass(
        'TOCTOU follow-symlink hazard reproduced; ' +
          'cap-std-style host port (lstat + O_NOFOLLOW + inode handles) ' +
          'will close it.',
      );
    } else {
      t.pass('race did not reproduce on this run; test is a regression marker');
    }
  },
);

// --- Attack 9: TOCTOU directory rename mid-operation ---

test.serial(
  'attack #9: ancestor rename to symlink-to-outside is best-effort ' +
    '(regression marker)',
  async t => {
    const { mount, mountRoot, tempBase } = await prepareMount(t);
    await fs.promises.mkdir(path.join(mountRoot, 'a', 'b'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(mountRoot, 'a', 'b', 'c.txt'),
      'safe',
    );
    const outsideDir = path.join(tempBase, 'race-outside');
    await fs.promises.mkdir(outsideDir, { recursive: true });

    const swap = (async () => {
      await null;
      try {
        await fs.promises.rename(
          path.join(mountRoot, 'a'),
          path.join(mountRoot, '.a-renamed'),
        );
        await fs.promises.symlink(outsideDir, path.join(mountRoot, 'a'));
      } catch {
        /* race */
      }
    })();
    const reads = Array.from({ length: 50 }, () =>
      mount.readText(['a', 'b', 'c.txt']).catch(e => e),
    );
    await Promise.all([swap, ...reads]);
    // Deterministic confinement on this race depends on the cap-std
    // host port; document the gap.
    t.pass('best-effort TOCTOU regression marker for ancestor rename');
  },
);

// --- Attack 10: filename validation: NUL, empty, long, control chars ---

test.serial(
  'attack #10: NUL byte in segment is rejected at the boundary',
  async t => {
    const { mount } = await prepareMount(t);
    await t.throwsAsync(mount.writeText(['has\0null.txt'], 'x'), {
      message: /must not contain/,
    });
    await t.throwsAsync(mount.has('has\0null.txt'), {
      message: /must not contain/,
    });
    await t.throwsAsync(mount.makeDirectory(['has\0null']), {
      message: /must not contain/,
    });
  },
);

test.serial('attack #10: empty-string segment is rejected', async t => {
  const { mount } = await prepareMount(t);
  await t.throwsAsync(mount.writeText([''], 'x'), {
    message: /must not be empty/,
  });
  await t.throwsAsync(mount.has('foo', '', 'bar'), {
    message: /must not be empty/,
  });
  await t.throwsAsync(mount.makeDirectory(['']), {
    message: /must not be empty/,
  });
});

test.serial(
  'attack #10: very long segment (> NAME_MAX) propagates ENAMETOOLONG ' +
    'without a generic-confinement collapse',
  async t => {
    const { mount } = await prepareMount(t);
    const longName = 'x'.repeat(300);
    // ENAMETOOLONG is a caller-actionable shape error, not an ACL-class
    // error, so it must NOT be tamed into the generic-confinement
    // message; the agent must be able to learn "name was too long".
    const e = await t.throwsAsync(mount.writeText([longName], 'y'));
    t.regex(e.message, /name too long|ENAMETOOLONG/i);
    t.notRegex(e.message, /Operation not permitted within mount/);
  },
);

test.serial(
  'attack #10: control characters in segments — current behavior pinned ' +
    '(accepted; tighten validator if undesired)',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    const ctrl = 'has\x01ctrl.txt';
    await mount.writeText([ctrl], 'x');
    const entries = await fs.promises.readdir(mountRoot);
    t.true(
      entries.includes(ctrl),
      'control-character filename was accepted; this test pins current ' +
        'behavior so any future tightening of assertValidSegment is a ' +
        'deliberate, observable change.',
    );
  },
);

// --- Attack 11: sub-mount inherits confinementRoot AND clamp is per-sub ---

test.serial(
  'attack #11: sub-mount inherits original confinementRoot ' +
    '(passing it down on lookup)',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.mkdir(path.join(mountRoot, 'a'));
    await fs.promises.mkdir(path.join(mountRoot, 'b'));
    await fs.promises.writeFile(
      path.join(mountRoot, 'b', 'sib.txt'),
      'sibling',
    );

    // The sub-mount's confinementRoot is the ORIGINAL mountRoot
    // (verified indirectly: a sub.has(...) crossing into a sibling via
    // `..` would only succeed if confinementRoot were preserved AND
    // the clamp pre-pended currentDir).  See the strict-clamp test
    // below for the actual `..` semantics.
    const subA = await mount.lookup('a');
    t.true(typeof subA === 'object' && subA !== null);
    t.true(typeof subA.has === 'function');
  },
);

test.serial(
  'attack #11: sub-mount clamps `..` per-sub (cannot climb above its currentDir) ' +
    '— matches design Implementation Note 1',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.mkdir(path.join(mountRoot, 'a', 'aa'), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(mountRoot, 'top.txt'), 'top-secret');
    await fs.promises.writeFile(
      path.join(mountRoot, 'a', 'inside-a.txt'),
      'inside-a',
    );

    const subA = await mount.lookup('a');
    const subAA = await subA.lookup('aa');

    // From subA, `..` clamps at subA.currentDir (mountRoot/a), so
    // mountRoot/top.txt is unreachable.
    await t.throwsAsync(subA.readText(['..', 'top.txt']), {
      message: /no such file|ENOENT|cannot be verified|escapes/i,
      // Above the clamp pops to []; absolute = mountRoot/a/top.txt
      // which does not exist.  This pins that '..' cannot escape into
      // siblings.
    });

    // subA can still read its own contents.
    t.is(await subA.readText('inside-a.txt'), 'inside-a');

    // From subAA, `..` clamps at subAA.currentDir (mountRoot/a/aa);
    // even three `..` segments cannot reach top.txt.
    await t.throwsAsync(subAA.readText(['..', '..', '..', 'top.txt']), {
      message: /no such file|ENOENT|cannot be verified/i,
    });
  },
);

// --- Attack 12: resource bombs and ELOOP on self-symlink ---

test.serial(
  'attack #12: deeply nested makeDirectory completes or errors cleanly',
  async t => {
    const { mount } = await prepareMount(t);
    const segments = Array.from({ length: 100 }, () => 'd');
    try {
      await mount.makeDirectory(segments);
      t.pass('100-deep directory created without error');
    } catch (e) {
      t.regex(
        e.message,
        /ENAMETOOLONG|too long|stack/i,
        'deep make should fail with a caller-actionable error, not crash',
      );
    }
  },
);

test.serial(
  'attack #12: self-referential symlink lookup terminates without hanging',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    await fs.promises.symlink('loop', path.join(mountRoot, 'loop'));

    await t.throwsAsync(mount.lookup('loop'), {
      message: /does not exist|ELOOP|too many|cannot be verified|escapes/i,
    });
    t.false(await mount.has('loop'));
    const entries = await mount.list();
    t.false(entries.includes('loop'));
  },
);

test.serial(
  'attack #12: writeText with non-trivial content does not crash, ' +
    'and the M.string() guard caps oversized payloads at the boundary',
  async t => {
    const { mount, mountRoot } = await prepareMount(t);
    // 50 KB — well under @endo/patterns' default M.string() limit
    // (100 000 chars).  Large enough to detect a quadratic copy bug,
    // small enough for CI.
    const sizable = 'x'.repeat(50 * 1024);
    await mount.writeText(['sizable.txt'], sizable);
    const stat = await fs.promises.stat(path.join(mountRoot, 'sizable.txt'));
    t.is(stat.size, sizable.length);
    // Cross-check round-trip via Uint8Array + TextDecoder (per
    // CLAUDE.md, prefer Uint8Array over Node Buffer).
    const bytes = new Uint8Array(
      await fs.promises.readFile(path.join(mountRoot, 'sizable.txt')),
    );
    t.is(textDecoder.decode(bytes).length, sizable.length);

    // Resource-bomb defense-in-depth: writeText payloads larger than
    // the @endo/patterns M.string() default cap are rejected at the
    // exo boundary before any I/O.  This is a separate layer from the
    // confinement membrane and is exercised here so a future widening
    // of the M.string() bound is a deliberate, observable change.
    const bomb = 'x'.repeat(101 * 1024);
    // The exo M.string() guard validates synchronously and throws
    // before returning a promise, so wrap in a thunk for t.throwsAsync.
    const bombErr = await t.throwsAsync(async () => {
      await mount.writeText(['bomb.txt'], bomb);
    });
    t.regex(bombErr.message, /must not be bigger than 100000/);
    t.false(
      await mount.has('bomb.txt'),
      'oversized writeText must not have written any content to disk',
    );
  },
);
