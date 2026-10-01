// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assembleBwrapArgv,
  makeBwrapSpawn,
  resolveSystemMounts,
  DEFAULT_SCRATCH_HOME,
} from '../src/bwrap-slice.js';

const baseOptions = harden({
  systemMounts: [
    { kind: /** @type {const} */ ('ro-bind'), source: '/usr', target: '/usr' },
    {
      kind: /** @type {const} */ ('symlink'),
      source: 'usr/bin',
      target: '/bin',
    },
  ],
  readOnlyPaths: ['/tmp/turn/endo-mcp-broker-1', '/tmp/turn/spawn-1'],
  writablePaths: ['/tmp/turn/work'],
  cwd: '/tmp/turn/work',
  command: '/opt/claude/claude',
  commandArguments: ['-p', '--bare'],
});

/**
 * The `[flag, source, target]` triples of an argv, for the mount flags.
 *
 * @param {string[]} argv
 */
const mountsOf = argv => {
  const mounts = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (['--ro-bind', '--bind', '--symlink'].includes(argv[index])) {
      mounts.push(argv.slice(index, index + 3));
      index += 2;
    }
  }
  return mounts;
};

test('the slice mounts only the system, the granted paths, and fresh tmpfs', t => {
  const argv = assembleBwrapArgv(baseOptions);
  t.deepEqual(argv.slice(0, 6), [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
  ]);
  t.deepEqual(mountsOf(argv), [
    ['--ro-bind', '/usr', '/usr'],
    ['--symlink', 'usr/bin', '/bin'],
    ['--ro-bind', '/tmp/turn/endo-mcp-broker-1', '/tmp/turn/endo-mcp-broker-1'],
    ['--ro-bind', '/tmp/turn/spawn-1', '/tmp/turn/spawn-1'],
    ['--bind', '/tmp/turn/work', '/tmp/turn/work'],
  ]);
  const separator = argv.indexOf('--');
  t.deepEqual(argv.slice(separator + 1), [
    '/opt/claude/claude',
    '-p',
    '--bare',
  ]);
  t.is(argv[argv.indexOf('--chdir') + 1], '/tmp/turn/work');
  const setenv = argv.indexOf('--setenv');
  t.deepEqual(argv.slice(setenv, setenv + 3), [
    '--setenv',
    'HOME',
    DEFAULT_SCRATCH_HOME,
  ]);
});

test('the tmpfs mounts precede the granted binds beneath them', t => {
  const argv = assembleBwrapArgv(baseOptions);
  const temporaryTmpfs = argv.findIndex(
    (value, index) => value === '--tmpfs' && argv[index + 1] === '/tmp',
  );
  const tmpfsHome = argv.findIndex(
    (value, index) =>
      value === '--tmpfs' && argv[index + 1] === DEFAULT_SCRATCH_HOME,
  );
  const firstGrant = argv.indexOf('/tmp/turn/endo-mcp-broker-1') - 1;
  t.true(temporaryTmpfs >= 0 && tmpfsHome >= 0);
  t.true(
    temporaryTmpfs < firstGrant,
    '/tmp tmpfs is mounted before the grants',
  );
  t.true(tmpfsHome < firstGrant, 'HOME tmpfs is mounted before the grants');
  const separator = argv.indexOf('--');
  t.true(firstGrant < separator);
});

test('a relative path is refused', t => {
  t.throws(
    () => assembleBwrapArgv({ ...baseOptions, readOnlyPaths: ['relative'] }),
    { message: /must be absolute/ },
  );
  t.throws(() => assembleBwrapArgv({ ...baseOptions, command: 'claude' }), {
    message: /must be absolute/,
  });
});

test('resolveSystemMounts recreates top-level symlinks and binds /etc targets', async t => {
  const symlinks = { '/bin': 'usr/bin', '/lib64': 'usr/lib64' };
  const directories = ['/usr', '/lib'];
  const real = {
    '/etc/resolv.conf': '/run/systemd/resolve/stub-resolv.conf',
    '/etc/hosts': '/etc/hosts',
  };
  const fileSystem = /** @type {any} */ ({
    lstat: async (/** @type {string} */ name) => {
      if (Object.hasOwn(symlinks, name) || directories.includes(name)) {
        return { isSymbolicLink: () => Object.hasOwn(symlinks, name) };
      }
      throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
    },
    readlink: async (/** @type {keyof typeof symlinks} */ name) =>
      symlinks[name],
    realpath: async (/** @type {string} */ name) => {
      if (Object.hasOwn(real, name)) return real[name];
      throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  const mounts = await resolveSystemMounts({ fileSystem });
  t.deepEqual(mounts, [
    { kind: 'ro-bind', source: '/usr', target: '/usr' },
    { kind: 'symlink', source: 'usr/bin', target: '/bin' },
    { kind: 'ro-bind', source: '/lib', target: '/lib' },
    { kind: 'symlink', source: 'usr/lib64', target: '/lib64' },
    { kind: 'ro-bind', source: '/etc/hosts', target: '/etc/hosts' },
    {
      kind: 'ro-bind',
      source: '/run/systemd/resolve/stub-resolv.conf',
      target: '/etc/resolv.conf',
    },
  ]);
});

test('makeBwrapSpawn runs the command under bwrap with the same options', t => {
  /** @type {unknown[][]} */
  const calls = [];
  const spawn = /** @type {any} */ (
    (/** @type {unknown[]} */ ...callArguments) => {
      calls.push(callArguments);
      return 'child';
    }
  );
  const slicedSpawn = makeBwrapSpawn({
    spawn,
    bwrapPath: '/usr/bin/bwrap',
    systemMounts: baseOptions.systemMounts,
    readOnlyPaths: baseOptions.readOnlyPaths,
    writablePaths: baseOptions.writablePaths,
  });
  const options = { cwd: '/tmp/turn/work', env: { PATH: '/usr/bin' } };
  t.is(
    /** @type {unknown} */ (slicedSpawn('/opt/claude/claude', ['-p'], options)),
    'child',
  );
  const [[command, bwrapArguments, passed]] = calls;
  t.is(command, '/usr/bin/bwrap');
  t.deepEqual(
    bwrapArguments,
    assembleBwrapArgv({ ...baseOptions, commandArguments: ['-p'] }),
  );
  t.is(passed, options);
  t.throws(() => slicedSpawn('/opt/claude/claude', [], {}), {
    message: /explicit cwd/,
  });
});
