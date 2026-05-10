# Mount.js saboteur sweep — 2026-05-10

PR: [endojs/endo-but-for-bots#122][pr122]
Module under attack: [`packages/daemon/src/mount.js`](../../packages/daemon/src/mount.js)
Design: [`designs/platform-fs-daemon-integration.md`](../../designs/platform-fs-daemon-integration.md)

[pr122]: https://github.com/endojs/endo-but-for-bots/pull/122

## Origin

Per [maintainer review request 2026-05-10T06:02:39Z][trigger]:

> Let's dispatch a dozen saboteurs to increase our confidence and produce
> any missing tests.
> Aggregate their responses and dispatch a fixer to merge their
> recommendations into test cases and any necessary fixes.

[trigger]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3219000000

This document is the aggregated output of the 12-attack-vector sweep.
A follow-up fixer dispatch lands the regression tests and any code
fixes the saboteurs flagged.

## Threat model

The `EndoMountDirectory` exo is the only directory-shaped capability
an agent ever holds onto a host filesystem subtree.
The agent is **not** trusted with ambient filesystem authority; the
exo is the membrane.

The saboteurs assume an adversary that:

- Holds an `EndoMountDirectory` reference (with or without `readOnly`).
- Can call any method on its public guard
  ([`MountDirectoryInterface` at `interfaces.js:512`](../../packages/daemon/src/interfaces.js)).
- Can supply arbitrary path-segment arguments through the cross-realm
  CapTP boundary (after `M.interface()` shape validation).
- **Cannot** modify the host filesystem out-of-band.
- **Cannot** observe wall-clock latency at finer than network-RTT
  resolution (mitigates pure timing channels but not large-difference
  observability).

A separate, weaker threat model: a benign agent on a host where some
*other* user with shell access creates symlinks into the mount path
mid-operation.
This covers the TOCTOU vectors.

## Confined invariants under attack

From [`designs/platform-fs-daemon-integration.md`](../../designs/platform-fs-daemon-integration.md)
Decisions 1, 4, 6 and Open Question 3:

1. **Path clamping.** `..` and `.` segments are clamped at the
   confinement root.
2. **cap-std-style symlink confinement.** Symlinks whose targets exit
   the mount (absolute targets, relative-with-`..` targets, broken
   targets) are invisible from `list()` and rejected from read paths.
3. **ACL-class error normalization.** `EACCES` / `EPERM` / `EROFS`
   collapse to "Operation not permitted within mount".
4. **Composition confinement.** A sub-directory exo obtained via
   `lookup(subdir)` inherits the **original** mount's `confinementRoot`,
   not its own `currentDir`.
5. **Read-only attenuation.** A `readOnly()`-derived exo rejects all
   mutations.
6. **Filename validation.** Segments containing `/`, `\\`, `\0`, or
   the empty string are rejected.

## Attack vectors

The 12 attacks below are organized by the invariant they target.
Each lists the scenario, the test-case skeleton, the expected
behavior, and a verdict per the saboteur convention:

- **ok** — invariant holds; ship the test as defensive coverage.
- **needs test** — invariant probably holds, but there is no test to
  prove it; ship the test.
- **needs fix** — invariant fails; the fixer must repair the code
  before the test will pass.

### 1. Path clamping: `..` traversal in path arguments

**Scenario.** A confined agent passes
`['..', '..', '..', 'etc', 'passwd']` to `lookup`, `has`, `readText`,
`writeText`, `remove`, `removeTree`, `move`, `copy`, `write`,
`makeDirectory`.
Each `..` segment should pop the accumulator at zero, never escaping.

**Skeleton.**

```js
test('mount: parent-traversal segments clamp at root, never escape', async t => {
  const { mount, mountPath } = await prepareMount(t);
  // Ample dot-dot exceeds any plausible mount depth.
  const escape = ['..', '..', '..', '..', '..', '..', '..', 'etc', 'passwd'];
  // Read paths normalize to mount-root operations and stay safe.
  t.true(await E(mount).has(...escape));
  // /etc/passwd must not be visible.
  await t.throwsAsync(E(mount).readText(escape), {
    message: /no such file|ENOENT/i,
  });
  // Writes clamp into a real file at mount-root/passwd, NOT /etc/passwd.
  await E(mount).writeText(escape, 'pwned');
  const onDisk = await fs.promises.readFile(
    path.join(mountPath, 'passwd'), 'utf-8',
  );
  t.is(onDisk, 'pwned');
  await t.throwsAsync(fs.promises.access('/etc/passwd-canary-from-mount'));
});
```

**Expected.** The clamp pops the accumulator at zero, so the effective
operation is on `mount-root/etc/passwd` (a write inside the mount), not
`/etc/passwd` (a write outside).
Existing test [`endo.test.js:4236`](../../packages/daemon/test/endo.test.js)
covers `has`/`list` with one `..`; this generalizes across all
mutation paths.

**Verdict.** **needs test.** The clamp logic at
[`mount.js:51`](../../packages/daemon/src/mount.js) appears correct.
No existing test exercises a write through an over-deep `..` chain.

---

### 2. Path clamping: absolute paths in path arguments

**Scenario.** Agent passes `['/etc/passwd']` (a single segment that
*is* an absolute path) or `['/', 'etc', 'passwd']` to any path-taking
method.
`assertValidSegment` rejects strings containing `/`, so a segment that
is itself `/etc/passwd` should fail validation.

**Skeleton.**

```js
test('mount: absolute-path segment rejected as invalid', async t => {
  const { mount } = await prepareMount(t);
  for (const seg of ['/etc/passwd', '/', 'foo/bar', 'a\\b']) {
    await t.throwsAsync(E(mount).has(seg), {
      message: /must not contain/,
    });
    await t.throwsAsync(E(mount).readText(seg), {
      message: /must not contain/,
    });
    await t.throwsAsync(E(mount).writeText(seg, 'x'), {
      message: /must not contain/,
    });
  }
});
```

**Expected.** Reject with the segment-validation error from
[`mount.js:32`](../../packages/daemon/src/mount.js), at the boundary,
before any I/O.

**Verdict.** **needs test.** Validation at
[`mount.js:27-35`](../../packages/daemon/src/mount.js) is in place;
no test confirms it triggers across all mutation surfaces.

---

### 3. Symlink confinement: target with `..` traversal

**Scenario.** External actor creates `mount-root/escape -> ../outside`.
Agent calls `lookup('escape')`, `has('escape')`, `readText('escape')`,
and tries `writeText` (write follows the symlink — Open Question 3).

**Skeleton.**

```js
test('mount: relative ../ symlink rejected on every read; write does not follow', async t => {
  const { mount, mountRoot, outsideDir } = await prepareSymlinkFixture(t);
  // Existing test in endo.test.js:4492 covers list/has/lookup; assert
  // the same for readText and maybeReadText.
  await t.throwsAsync(E(mount).readText('escape-rel'), {
    message: /escapes mount root|no such/i,
  });
  t.is(await E(mount).maybeReadText('escape-rel'), undefined);
  // Writing through the symlink: the symlink target is ../outside (a
  // directory).  writeText into a directory should EISDIR or escape-reject.
  await t.throwsAsync(E(mount).writeText(['escape-rel', 'inject.txt'], 'x'));
  // Outside directory must not have gained files.
  const after = await fs.promises.readdir(outsideDir);
  t.deepEqual(after, ['secret.txt'],
    'mount may not create entries outside the confinement root');
});
```

**Expected.** Read paths (`lookup`/`has`/`readText`/`maybeReadText`)
reject or return undefined; writes do not create files outside.

**Verdict.** **needs test** for `readText` and `maybeReadText`
(existing tests cover `list`/`has`/`lookup` only).
**Likely needs fix** for the write-through-symlink case per Open
Question 3 in the design.

---

### 4. Symlink confinement: absolute target

**Scenario.** External actor creates `mount-root/abslink -> /etc`.
Agent calls every read method, then attempts to read or write under
`/etc` indirectly.

**Skeleton.**

```js
test('mount: absolute-target symlink fully confined across all read methods', async t => {
  const { mount, mountRoot } = await prepareSymlinkFixture(t);
  for (const method of ['readText', 'maybeReadText']) {
    if (method === 'maybeReadText') {
      t.is(await E(mount)[method]('escape-abs'), undefined);
    } else {
      await t.throwsAsync(E(mount)[method]('escape-abs'), {
        message: /escapes|no such/i,
      });
    }
  }
  // List should not reveal the entry.
  const entries = await E(mount).list();
  t.false(entries.includes('escape-abs'));
  // Recursive list of a symlinked subdirectory should not exfiltrate /etc.
  await t.throwsAsync(E(mount).list('escape-abs'), {
    message: /escapes/i,
  });
});
```

**Expected.** Same generic-confinement-error message; the agent cannot
distinguish "no such file" from "exists but escapes" beyond what the
design promises.

**Verdict.** **needs test.** [`mount.js:299-319`](../../packages/daemon/src/mount.js)
filters `list`, but no test exercises `list(symlinkSegment)` (passing
the symlink as the directory to list — recursive escape attempt).

---

### 5. Symlink confinement: chain of symlinks crossing the boundary

**Scenario.** External actor builds a chain: `mount-root/a -> b`,
`mount-root/b -> c`, `mount-root/c -> /etc/passwd`.
Each link individually points inside the mount; only the chain crosses
the boundary.
`realPath` resolves the entire chain in one call, so `assertConfined`
should catch the escape at the resolved target.

**Skeleton.**

```js
test('mount: chained symlinks ending outside the mount are rejected', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.symlink('b', path.join(mountRoot, 'a'));
  await fs.promises.symlink('c', path.join(mountRoot, 'b'));
  await fs.promises.symlink('/etc/passwd', path.join(mountRoot, 'c'));
  // realPath of mountRoot/a follows the chain → /etc/passwd → escapes.
  await t.throwsAsync(E(mount).readText('a'), {
    message: /escapes mount root/,
  });
  await t.throwsAsync(E(mount).lookup('a'), {
    message: /escapes mount root/,
  });
  t.false(await E(mount).has('a'),
    'has() must hide a chain escaping the mount');
  const entries = await E(mount).list();
  t.false(entries.includes('a'),
    'list() must hide a chain escaping the mount');
});
```

**Expected.** `realPath` collapses the chain to `/etc/passwd`; the
`startsWith` check on `rootResolved + '/'` fails; the assertion fires.

**Verdict.** **needs test.** Logic at
[`mount.js:95-109`](../../packages/daemon/src/mount.js) and
[`mount.js:159-168`](../../packages/daemon/src/mount.js) is correct
in principle (`realPath` follows chains); no test exercises the chain.

---

### 6. ACL-class error normalization: EACCES/EPERM/EROFS leak attempts

**Scenario.** Agent attempts to write to a path whose parent has had
its permissions chmod'd to 000 by an external actor (or to a path on
a read-only-mounted subtree).
The native `fs.writeFile` throws `EACCES` / `EPERM` / `EROFS` with a
message that includes the **absolute filesystem path**, the **errno**,
and the **syscall name**.
`tameAclErrors` at [`mount.js:191`](../../packages/daemon/src/mount.js)
must replace this with the generic confinement message.

**Skeleton.**

```js
test('mount: EACCES/EPERM/EROFS messages do not leak host paths or syscall names', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.mkdir(path.join(mountRoot, 'locked'));
  await fs.promises.chmod(path.join(mountRoot, 'locked'), 0o000);
  t.teardown(async () => {
    await fs.promises.chmod(path.join(mountRoot, 'locked'), 0o755);
  });
  // running as non-root: writing to locked/file fails EACCES; the
  // Mount layer must surface "Operation not permitted within mount"
  // and NOT include the absolute path or the syscall name.
  const e = await t.throwsAsync(E(mount).writeText(['locked', 'file'], 'x'));
  t.regex(e.message, /Operation not permitted within mount/);
  t.notRegex(e.message, new RegExp(mountRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'error message must not echo the host filesystem path');
  t.notRegex(e.message, /EACCES|EPERM|EROFS|errno|syscall|open|write/i,
    'error message must not leak OS error code or syscall name');
  t.is(e.cause, undefined,
    'cause chain must be dropped to prevent host-detail leak');
});
```

**Expected.** Generic confinement message; no `cause`; no syscall
name; no absolute path.

**Verdict.** **needs test.** The implementation at
[`mount.js:201-203`](../../packages/daemon/src/mount.js) drops the
original error and creates a fresh one, so `cause` is naturally
undefined; this test pins the behavior.

---

### 7. ACL-class error normalization: ENOENT vs EACCES distinguishability

**Scenario.** A confined agent could probe whether a host file exists
by exploiting the difference between "does not exist" (ENOENT) and
"exists but no permission" (EACCES).
The design preserves ENOENT as a caller-actionable signal but tames
EACCES; this is **intentional** but the surface area of the leak
should be quantified by tests.

**Skeleton.**

```js
test('mount: probing host file existence through ENOENT-vs-confinement is bounded', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  // Inside the mount, a missing file vs a permission-denied file:
  await fs.promises.writeFile(path.join(mountRoot, 'permdenied.txt'), 'x');
  await fs.promises.chmod(path.join(mountRoot, 'permdenied.txt'), 0o000);
  t.teardown(async () => {
    await fs.promises.chmod(path.join(mountRoot, 'permdenied.txt'), 0o644);
  });

  // Missing file: maybeReadText returns undefined.
  t.is(await E(mount).maybeReadText('absent.txt'), undefined);

  // Permission-denied file: must NOT distinguish itself by message
  // detail.  maybeReadText must either return undefined OR throw the
  // generic confinement error — never the raw EACCES with a path.
  // Currently maybeReadText catches ANY error and returns undefined,
  // so this is already collapsed to "indistinguishable from absent".
  t.is(await E(mount).maybeReadText('permdenied.txt'), undefined);

  // For readText (the throwing form), both should produce errors
  // whose messages do not differ in any way that reveals existence
  // beyond the generic confinement message vs ENOENT.
  const eAbsent = await t.throwsAsync(E(mount).readText('absent.txt'));
  const eDenied = await t.throwsAsync(E(mount).readText('permdenied.txt'));
  // Both errors must NOT echo the absolute mount-root path, and must
  // NOT differ in a way that lets the agent distinguish the two
  // beyond the documented (ENOENT, generic confinement) split.
  for (const e of [eAbsent, eDenied]) {
    t.notRegex(e.message, new RegExp(mountRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
```

**Expected.** `readText` on a permdenied file currently propagates the
underlying `fs.readFile` error directly (no `tameAclErrors` wrap on
the read paths!).
This is a **leak**: the agent gets `EACCES: permission denied, open
'/full/host/path/permdenied.txt'`.

**Verdict.** **needs fix.** The `tameAclErrors` wrapper at
[`mount.js:344, 353`](../../packages/daemon/src/mount.js) is **not
applied** to `readText` / `maybeReadText` / `text()` on the
[`MountFile` exo at `mount.js:481-485`](../../packages/daemon/src/mount.js).
A read of a permission-denied file inside the mount leaks the host
absolute path through the Node-formatted EACCES message.
Either wrap the read paths in `tameAclErrors`, or document that read
paths intentionally surface OS errors and accept the leak.

---

### 8. TOCTOU: symlink swap mid-operation

**Scenario.** External actor swaps `mount-root/file` from a regular
file to `mount-root/file -> /etc/passwd` between
`assertConfined`/`assertConfinedOrAncestor` and the actual write.
The window: line N (assert) → line N+1 (write).

**Skeleton.**

```js
test('mount: symlink swap between assertion and write does not exfiltrate (best-effort)', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.writeFile(path.join(mountRoot, 'target.txt'), 'safe');

  // Concurrent task swaps target.txt to a /etc/passwd symlink.
  let swapped = false;
  const swap = (async () => {
    // Attempt to interleave; deterministic timing is impossible on node:fs.
    for (let i = 0; i < 50 && !swapped; i += 1) {
      try {
        await fs.promises.unlink(path.join(mountRoot, 'target.txt'));
        await fs.promises.symlink('/etc/passwd', path.join(mountRoot, 'target.txt'));
        swapped = true;
      } catch { /* race; retry */ }
    }
  })();

  // Repeated writes; if even one slips through to /etc/passwd we fail.
  const writes = [];
  for (let i = 0; i < 50; i += 1) {
    writes.push(E(mount).writeText(['target.txt'], `write-${i}`).catch(() => {}));
  }
  await Promise.all([...writes, swap]);

  // /etc/passwd must not have been touched.  We cannot read /etc/passwd
  // safely in the test, so instead assert the symlink has no leaked
  // content trail — the test is fundamentally best-effort on node:fs
  // and serves as a regression marker for the cap-std-style host port.
  if (swapped) {
    const lst = await fs.promises.lstat(path.join(mountRoot, 'target.txt'));
    // After the race, the entry is either the symlink (intact) or has
    // been replaced by writeFileText, which FOLLOWS the symlink and
    // writes to /etc/passwd.  This is the Open Question 3 hazard.
    t.true(lst.isSymbolicLink() || lst.isFile(),
      'state must be one of: symlink intact, or replaced by write');
    if (lst.isFile()) {
      t.fail('TOCTOU: writeFileText followed the symlink — Open Question 3');
    }
  }
  t.pass('best-effort TOCTOU regression marker');
});
```

**Expected.** On node:fs, this is **fundamentally racy**.
The test is a regression marker that becomes non-best-effort once a
cap-std-style host (Rust inode handles) lands.
Until then, the test documents the hazard without claiming the bug is
fixed.

**Verdict.** **needs test** (as a regression marker).
The mitigation is the cap-std follow-up; the test is documented as
best-effort under the current node:fs backend.
This corresponds to design Open Question 3.

---

### 9. TOCTOU: directory rename mid-operation

**Scenario.** External actor renames a parent directory of the
operation's target between segment-walk and use.
e.g. `mount-root/a/b/c.txt` is the target; mid-operation,
`mount-root/a` is renamed to `mount-root/escape-link` (a symlink to
`/tmp`).

**Skeleton.**

```js
test('mount: ancestor rename to symlink-to-outside fails closed (best-effort)', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.mkdir(path.join(mountRoot, 'a', 'b'), { recursive: true });
  await fs.promises.writeFile(path.join(mountRoot, 'a', 'b', 'c.txt'), 'safe');
  // Best-effort race; on a deterministic host this becomes a hard test.
  const swap = (async () => {
    try {
      await fs.promises.rename(
        path.join(mountRoot, 'a'),
        path.join(mountRoot, '.a-renamed'));
      await fs.promises.symlink('/tmp', path.join(mountRoot, 'a'));
    } catch { /* race */ }
  })();
  const reads = Array.from({ length: 50 }, () =>
    E(mount).readText(['a', 'b', 'c.txt']).catch(e => e));
  await Promise.all([swap, ...reads]);
  // Best-effort: assert nothing in /tmp was created with mount content.
  t.pass('best-effort TOCTOU regression marker for ancestor rename');
});
```

**Verdict.** **needs test** (best-effort regression marker).
Same as #8: mitigation is the cap-std host port.

---

### 10. Filename validation: NUL bytes, very long names, control chars

**Scenario.** Agent supplies path segments containing exotic
characters that the underlying filesystem might reject, accept, or
interpret differently than `assertValidSegment` expects:

- `\0` in the middle of a segment.
- A 10000-character segment (NAME_MAX is 255 on most filesystems).
- Control characters `\x01` through `\x1F`.
- Unicode normalization tricks (NFC vs NFD: `é` as one code point vs
  `e` + combining acute).
- Bidi override `‮` (right-to-left override; can mask filename
  intent).
- Trailing dot or space (Windows-only quirk; safe on POSIX).
- Reserved Windows names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`).

**Skeleton.**

```js
test('mount: NUL byte in segment is rejected at the boundary', async t => {
  const { mount } = await prepareMount(t);
  await t.throwsAsync(E(mount).writeText(['has\0null.txt'], 'x'),
    { message: /must not contain.*\\0/ });
  await t.throwsAsync(E(mount).has('has\0null.txt'),
    { message: /must not contain/ });
});

test('mount: very long segment names accepted up to NAME_MAX', async t => {
  const { mount } = await prepareMount(t);
  // NAME_MAX is typically 255; the Mount layer does NOT cap length.
  // The underlying fs will return ENAMETOOLONG; that should propagate
  // as a normal caller-actionable error (NOT a generic confinement
  // error, since ENAMETOOLONG is not in the ACL class).
  const longName = 'x'.repeat(300);
  await t.throwsAsync(E(mount).writeText([longName], 'y'),
    { message: /name too long|ENAMETOOLONG/i });
});

test('mount: control characters in segments — current behavior pinned', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  // Control chars (\x01-\x1F except \0) are NOT rejected by
  // assertValidSegment.  Pin current behavior: they reach node:fs
  // and either succeed (creating a weird filename) or fail with the
  // underlying OS error.  This test documents the gap and serves as
  // the conversation starter for whether to tighten the validator.
  const ctrl = 'has\x01ctrl.txt';
  await E(mount).writeText([ctrl], 'x');
  const entries = await fs.promises.readdir(mountPath);
  t.true(entries.includes(ctrl),
    'control-character filename was accepted; tighten validator if undesired');
});

test('mount: empty-string segment is rejected', async t => {
  const { mount } = await prepareMount(t);
  await t.throwsAsync(E(mount).writeText([''], 'x'),
    { message: /must not be empty/ });
  await t.throwsAsync(E(mount).has('foo', '', 'bar'),
    { message: /must not be empty/ });
});
```

**Expected.**

- NUL: rejected.
- Empty string: rejected.
- Long names: pass through to OS, OS errors propagate
  (caller-actionable).
- Control chars: currently pass through; the test pins this so a
  future tightening is a deliberate choice.

**Verdict.** **needs test.** No bug, but the gap (control chars,
NAME_MAX overrun) deserves explicit characterization.
The fixer should not tighten the validator without maintainer review;
just pin the current behavior.

---

### 11. Composition: `makeDirectory(child)` confinement inheritance + sibling isolation

**Scenario.** Two sub-directory exos obtained by `lookup('a')` and
`lookup('b')` from the same root must:

1. Each inherit the **original** `confinementRoot` (not their own
   `currentDir`).
2. Not be able to reach each other's contents via `..`.
3. Reject any operation that would escape the original root.

**Skeleton.**

```js
test('mount: sub-mount inherits original confinementRoot, not its own currentDir', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.mkdir(path.join(mountRoot, 'a'), { recursive: true });
  await fs.promises.mkdir(path.join(mountRoot, 'b'), { recursive: true });
  await fs.promises.writeFile(path.join(mountRoot, 'b', 'sib.txt'), 'sibling');

  const subA = await E(mount).lookup('a');
  // subA.currentDir is mount-root/a; confinementRoot is mount-root.
  // From subA we can navigate into b (sibling) via '..', because
  // confinementRoot is the ORIGINAL mount root.
  const sibText = await E(subA).readText(['..', 'b', 'sib.txt']);
  t.is(sibText, 'sibling',
    'sub-mount may navigate up to mount-root and into siblings');
  // But subA cannot escape PAST mount-root.
  await t.throwsAsync(E(subA).readText(['..', '..', '..', 'etc', 'passwd']));
});

test('mount: nested sub-mount cannot use .. to escape its parent sub-mount', async t => {
  // Per design: PR 122 deliberately STRENGTHENED this — clampSegments
  // pops at zero relative to currentDir, NOT to confinementRoot.
  // So a doubly-nested sub-mount can use '..' to climb to its parent's
  // currentDir, but cannot climb past the immediate parent.
  // Wait — re-read mount.js:51 clampSegments and mount.js:79
  // segmentsToAbsolutePath: clamping happens RELATIVE to the segment
  // accumulator (popping at zero), THEN absolute path is built from
  // currentDir.  So '..' from a sub-mount IS effectively clamped at
  // currentDir, not at confinementRoot.  Decision 1 / Implementation
  // Note: "a sub-mount handed to an agent can no longer use .. to
  // traverse back toward the original mount root."
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.mkdir(path.join(mountRoot, 'a', 'aa'), { recursive: true });
  await fs.promises.writeFile(path.join(mountRoot, 'top.txt'), 'top-secret');
  const subA = await E(mount).lookup('a');
  const subAA = await E(subA).lookup('aa');
  // From sub-A-A: '..' clamps at sub-A-A's currentDir (no escape).
  // Should NOT reach mount-root/top.txt.
  await t.throwsAsync(E(subAA).readText(['..', '..', '..', 'top.txt']),
    { message: /no such file|ENOENT|escapes/i },
    'sub-sub-mount cannot use .. to climb above its currentDir');
});
```

**Expected.** Per design Implementation Note 1
([`designs/platform-fs-daemon-integration.md:421-431`](../../designs/platform-fs-daemon-integration.md)),
the clamp is relative to `currentDir`, so a sub-mount's `..` clamps at
its own current directory, not at `confinementRoot`.
The first test above expects the **older, weaker** behavior (sibling
reachable via `..`); the second test pins the **new, stronger**
behavior (sub-sub cannot climb).
The fixer must reconcile what behavior is expected and assert the
correct one.

**Verdict.** **needs test** AND **needs investigation.**
Re-reading [`mount.js:263-267`](../../packages/daemon/src/mount.js):
`clampSegments` is called on the agent-supplied segments alone, with
no awareness of the path from `currentDir` back to `confinementRoot`.
So `..` pops at zero of the *supplied segments*, never crossing into
`currentDir`'s ancestors. The first test ABOVE will FAIL — `subA`
cannot reach `b` via `..`.
The fixer should write the test in the form that matches the
implementation, asserting **strict per-sub-mount confinement**
(matches Implementation Note 1's "strengthening" claim).

---

### 12. Resource bombs: deeply nested directories, huge files, recursive symlinks

**Scenario.** Agent attempts to exhaust host resources:

- `makeDirectory(['a','a','a',...,'a'])` with 10000 segments.
- `writeText` with a 1 GB content string.
- Create a self-referential symlink and recurse through it (`a -> a`,
  then `lookup('a')`).

**Skeleton.**

```js
test('mount: deeply nested makeDirectory completes or errors cleanly', async t => {
  const { mount } = await prepareMount(t);
  const segments = Array.from({ length: 100 }, () => 'd');
  // 100-deep is well under any plausible filesystem limit.
  // The mount layer does not cap depth; underlying fs eventually
  // throws ENAMETOOLONG.  Either outcome is acceptable; the test
  // pins that the daemon does not crash.
  try {
    await E(mount).makeDirectory(segments);
    t.pass('100-deep directory created without error');
  } catch (e) {
    t.regex(e.message, /ENAMETOOLONG|too long|stack/i,
      'deep make should fail with a caller-actionable error, not crash');
  }
});

test('mount: self-referential symlink lookup terminates with ELOOP', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  await fs.promises.symlink('loop', path.join(mountRoot, 'loop'));
  // realPath on a self-referential symlink throws ELOOP.
  // assertConfined catches the throw and reports "does not exist
  // and cannot be verified".  lookup() should propagate that.
  await t.throwsAsync(E(mount).lookup('loop'),
    { message: /does not exist|ELOOP|too many|cannot be verified/i });
  // has() should return false (not hang).
  t.false(await E(mount).has('loop'));
  // list() should NOT include the broken/looping entry.
  const entries = await E(mount).list();
  t.false(entries.includes('loop'));
});

test('mount: writeText with very large content does not crash daemon', async t => {
  const { mount, mountRoot } = await prepareMount(t);
  // 10 MB — large enough to detect a quadratic copy bug, small enough
  // to run in CI without hammering disk.
  const big = 'x'.repeat(10 * 1024 * 1024);
  await E(mount).writeText(['big.txt'], big);
  const onDisk = await fs.promises.stat(path.join(mountRoot, 'big.txt'));
  t.is(onDisk.size, big.length);
});
```

**Expected.** No daemon crashes; `ELOOP` on symlink loops bubbles as
"does not exist"; large writes work or fail with a caller-actionable
error.

**Verdict.** **needs test.** No bug expected; this is hardening
coverage. The self-referential-symlink case is the only one that
might surprise — if `realPath` hangs instead of throwing `ELOOP` (it
does throw on Linux), the test catches it.

---

## Aggregated findings

### Verdict roll-up

| # | Attack | Verdict |
|---|--------|---------|
|  1 | Path-clamping `..` traversal across all mutations | needs test |
|  2 | Path-clamping absolute-path segment rejection | needs test |
|  3 | Symlink relative-target across read paths + write hazard | needs test (+ Open Q 3) |
|  4 | Symlink absolute-target full-coverage including `list(symlink)` | needs test |
|  5 | Symlink chain crossing the boundary | needs test |
|  6 | EACCES/EPERM/EROFS message-leak audit | needs test |
|  7 | ENOENT-vs-EACCES distinguishability on read paths | **needs fix** |
|  8 | TOCTOU symlink swap (best-effort regression marker) | needs test |
|  9 | TOCTOU directory rename (best-effort regression marker) | needs test |
| 10 | NUL / empty / long / control-char filename validation | needs test |
| 11 | Sub-mount per-sub `..` clamping (strict confinement) | needs test |
| 12 | Resource bombs and ELOOP on self-symlink | needs test |

### Must-fix list

**One bug surfaced.** Attack #7 reveals that `readText`,
`maybeReadText`, and `MountFile.text()` do **not** wrap their
underlying `filePowers.readFileText` calls in `tameAclErrors`.
A read of a permission-denied file inside the mount surfaces
Node's raw `EACCES: permission denied, open '<absolute host path>'`
message, leaking the mount root's absolute filesystem path and the
syscall name to the agent.

Code sites:

- [`mount.js:339-345`](../../packages/daemon/src/mount.js) — `readText`.
- [`mount.js:347-357`](../../packages/daemon/src/mount.js) —
  `maybeReadText` already swallows all errors via a bare `catch`, so
  this one is *unintentionally* safe (returns `undefined` on EACCES);
  the test pins this so it does not regress.
- [`mount.js:481-485`](../../packages/daemon/src/mount.js) —
  `MountFile.text()`.
- [`mount.js:494-496`](../../packages/daemon/src/mount.js) —
  `MountFile.json()` likewise reads via `readFileText`.

**Recommended fix.** Wrap the read sites with `tameAclErrors`:

```js
async readText(pathArg) {
  await null;
  const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
  const { absolute } = clamp(segments);
  await assertConfined(absolute, confinementRoot, filePowers);
  return tameAclErrors(() => filePowers.readFileText(absolute));
},
```

(Same shape applies to `MountFile.text()` and `MountFile.json()`.)

The fix is mechanical and small.

### Pre-existing open question (#3 in design)

Attack #3's write-through-symlink hazard is already documented as
[Open Question 3](../../designs/platform-fs-daemon-integration.md)
in the design.
The saboteur sweep flags it as **needs follow-up** rather than a
must-fix in this PR; the test ships as a regression marker that will
fail when the cap-std host port lands the `lstat`+`unlink` mitigation.

### Sub-mount confinement: re-read against implementation

The original prompt's attack-vector 11 was framed in terms of
"sibling isolation".
On re-reading [`mount.js:51-67`](../../packages/daemon/src/mount.js),
`clampSegments` operates only on the agent-supplied segment array and
pops at zero, so it never crosses into `currentDir`'s ancestors.
This is **correct** per design Implementation Note 1's "strengthening"
language; the test must be written in the form that asserts the
strong invariant (sub-mount cannot climb above its `currentDir`),
not the weak one (sibling reachable via `..`).
The fixer should adopt the second form of the test in attack #11.

## Test-file placement

All new tests should land in
[`packages/daemon/test/mount.test.js`](../../packages/daemon/test/) (new
file), **not** appended to `endo.test.js`.
The existing mount tests in `endo.test.js:3918-4568` may stay in
place; the new file uses a focused fixture helper (no full daemon
fork is required for the unit-level path-clamping and segment-
validation tests, though the symlink and TOCTOU tests do need a
daemon to drive `EndoMountDirectory` via `provideMount`).

The choice between full-daemon (`provideMount`-based) and
direct-`makeMount`-construction tests is a fixer call; the tests above
are written in the daemon-fork style for parity with the existing
mount tests.
A more isolated, faster test file that constructs `makeMount` with a
mock `FilePowers` would be appropriate for attacks #1, #2, #10 (pure
segment-validation paths) and would run in milliseconds rather than
seconds.

## Saboteur-discovered surprises

- **`maybeReadText` is unintentionally well-behaved.** Its bare
  `catch` swallows EACCES along with ENOENT, so it does not leak host
  detail. This is the right behavior, but it is a happy accident; a
  refactor that "tightens" the catch (e.g. only swallowing ENOENT)
  would re-open the leak. The test in attack #7 pins this.
- **`assertConfinedOrAncestor` walks to `joinPath(check, '..')`
  until `parent === check`.** On POSIX this terminates at `/`. The
  loop is correct but worth the regression test (#1).
- **`makeDirectoryHere('.')` and `makeDirectoryHere('..')`** call
  `clamp(['.'])` and `clamp(['..'])` respectively, both of which
  return `[]`, so `clamped[0]` is `undefined` and the platform
  `directory.makeDirectoryHere(undefined)` is invoked. This will
  throw a type-shape error from the platform side, but it would be
  more idiomatic to reject earlier with a useful message. Listed
  here as a nit rather than a fix-required.

## Self-improvement note

This sweep was conducted by a single agent acting as the saboteur
panel rather than as 12 dispatched sub-agents, because the harness
in use does not surface an Agent/Task tool.
The aggregation step degenerates to "section structure" rather than
"deduplication across independent reports"; the verdict roll-up and
must-fix list are produced inline.
This is recorded so the steward can decide whether to widen the
saboteur-batching skill to include "single-agent multi-vector"
guidance for harnesses without sub-agent dispatch.
