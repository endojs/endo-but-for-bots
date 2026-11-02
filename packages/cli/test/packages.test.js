// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import url from 'url';
import { promisify } from 'util';
import { gzip } from 'zlib';

import test from 'ava';
import { execa } from 'execa';
import {
  tarEndMarker,
  tarFileHeader,
  tarFilePadding,
} from '@endo/tar/writer.js';

import { extractPackageTarball, fetchPackage } from '../src/packages/fetch.js';
import {
  isPackageSource,
  parsePackageSource,
  readPackageManifest,
} from '../src/packages/manifest.js';
import { makePackageStore } from '../src/packages/store.js';

const endoBin = url.fileURLToPath(new URL('../bin/endo.cjs', import.meta.url));
const compress = promisify(gzip);

const makeTemporaryDirectory = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'endo-packages-'));
  t.teardown(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
const writeTree = async (root, files) => {
  for (const [relative, text] of Object.entries(files)) {
    const location = path.join(root, relative);
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(path.dirname(location), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(location, text);
  }
};

const packageFiles = harden({
  'package.json': JSON.stringify({ name: 'sample', version: '1.0.0' }),
  'skills/alpha/SKILL.md': 'alpha',
  'skills/alpha/references/api.md': 'api',
  'prompts/review.md': 'review',
});

const isFilePresent = location =>
  fs.lstat(location).then(
    () => true,
    () => false,
  );

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} [files]
 */
const makeFixture = async (t, files = packageFiles) => {
  const packageRoot = await makeTemporaryDirectory(t);
  await writeTree(packageRoot, files);
  const home = await makeTemporaryDirectory(t);
  const source = parsePackageSource(packageRoot, home);
  return { packageRoot, home, source, store: makePackageStore(home) };
};

test('parsePackageSource reads npm sources and pins exact versions', t => {
  const floating = parsePackageSource('npm:@foo/bar', '/work');
  t.like(floating, {
    kind: 'npm',
    id: 'npm:@foo/bar',
    specifier: '@foo/bar',
    pinned: false,
  });
  const exact = parsePackageSource('npm:@foo/bar@1.2.3', '/work');
  t.is(exact.id, floating.id, 'the version is not part of the identity');
  t.like(exact, { specifier: '@foo/bar@1.2.3', pinned: true });
  t.false(parsePackageSource('npm:bar@next', '/work').pinned);
});

test('parsePackageSource reads git sources over https', t => {
  t.like(parsePackageSource('git:github.com/user/repo', '/work'), {
    id: 'git:github.com/user/repo',
    url: 'https://github.com/user/repo',
    pinned: false,
  });
  t.like(parsePackageSource('git:github.com/user/repo@v1', '/work'), {
    id: 'git:github.com/user/repo',
    text: 'git:github.com/user/repo@v1',
    reference: 'v1',
    pinned: true,
  });
});

test('parsePackageSource resolves local paths against the directory', t => {
  t.like(parsePackageSource('../there', '/work/here'), {
    kind: 'file',
    id: 'file:/work/there',
    directory: '/work/there',
  });
  t.is(parsePackageSource('file:/there', '/work').id, 'file:/there');
});

for (const invalid of [
  'bare-name',
  'npm:--global',
  'npm:bar@--tag=x',
  'npm:git+ssh://host/repo',
  'npm:../bar',
  'git:github.com',
  'git:github.com/../repo',
  'git:github.com/user/repo@--upload-pack=x',
  'git:-oProxyCommand=x/repo',
  'git:user@github.com/repo',
  'file:',
]) {
  test(`parsePackageSource refuses ${invalid}`, t => {
    t.throws(() => parsePackageSource(invalid, '/work'));
  });
}

test('isPackageSource leaves ordinary pet names alone', t => {
  t.true(isPackageSource('npm:@foo/bar'));
  t.true(isPackageSource('git:github.com/user/repo'));
  t.true(isPackageSource('file:/there'));
  t.false(isPackageSource('counter'));
  t.false(isPackageSource('dir/counter'));
});

test('readPackageManifest discovers conventional directories without an endo key', async t => {
  const { packageRoot } = await makeFixture(t);
  const { name, version, directories } = await readPackageManifest(packageRoot);
  t.is(name, 'sample');
  t.is(version, '1.0.0');
  t.deepEqual(directories, {
    skills: ['./skills'],
    prompts: ['./prompts'],
    guests: [],
    providers: [],
  });
});

test('readPackageManifest honors the endo key and ignores unknown kinds', async t => {
  const packageRoot = await makeTemporaryDirectory(t);
  await writeTree(packageRoot, {
    'package.json': JSON.stringify({
      name: 'sample',
      endo: { skills: ['./lib/skills'], themes: ['./themes'] },
    }),
    'prompts/ignored.md': 'not declared',
  });
  const { directories } = await readPackageManifest(packageRoot);
  t.deepEqual(directories.skills, ['./lib/skills']);
  t.deepEqual(directories.prompts, [], 'the endo key replaces discovery');
  t.false('themes' in directories);
});

test('readPackageManifest refuses a package with no package.json', async t => {
  const packageRoot = await makeTemporaryDirectory(t);
  await t.throwsAsync(readPackageManifest(packageRoot), {
    message: /No readable package\.json/,
  });
});

test('readPackageManifest reports malformed JSON with its location', async t => {
  const packageRoot = await makeTemporaryDirectory(t);
  await writeTree(packageRoot, { 'package.json': '{' });
  await t.throwsAsync(readPackageManifest(packageRoot), {
    message: /Invalid JSON in .*package\.json/,
  });
});

for (const entry of ['../outside', '/etc', './skills/../../outside']) {
  test(`readPackageManifest refuses the escaping entry ${entry}`, async t => {
    const packageRoot = await makeTemporaryDirectory(t);
    await writeTree(packageRoot, {
      'package.json': JSON.stringify({
        name: 'sample',
        endo: { skills: [entry] },
      }),
    });
    await t.throwsAsync(readPackageManifest(packageRoot), {
      message: /escapes the package/,
    });
  });
}

test('install places skills and prompts and records them', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  const { record } = await store.install(source, packageRoot);
  t.deepEqual(record.resources, { skills: ['alpha'], prompts: ['review.md'] });
  t.is(
    await fs.readFile(
      path.join(home, '.agents/skills/alpha/references/api.md'),
      'utf8',
    ),
    'api',
  );
  t.is(
    await fs.readFile(path.join(home, '.agents/prompts/review.md'), 'utf8'),
    'review',
  );
  const [listed] = await store.list();
  t.is(listed.id, source.id);
  t.is(listed.version, '1.0.0');
});

test('install records guests and providers as pending, not installed', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t, {
    ...packageFiles,
    'guests/agent.js': '',
    'providers/model.js': '',
  });
  const { record } = await store.install(source, packageRoot);
  t.deepEqual(record.pending, {
    guests: ['./guests'],
    providers: ['./providers'],
  });
  t.false(await isFilePresent(path.join(home, '.agents/guests')));
});

test('install refuses a package with nothing it can place', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t, {
    'package.json': JSON.stringify({ name: 'sample' }),
    'guests/agent.js': '',
  });
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /no skills or prompts/,
  });
  t.deepEqual(await store.list(), []);
  t.false(await isFilePresent(path.join(home, '.agents/skills')));
});

test('reinstalling removes what the new version dropped', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  await fs.rm(path.join(packageRoot, 'prompts/review.md'));
  await writeTree(packageRoot, { 'skills/alpha/SKILL.md': 'alpha two' });
  await store.install(source, packageRoot);
  t.false(await isFilePresent(path.join(home, '.agents/prompts/review.md')));
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'alpha two',
  );
  t.is((await store.list()).length, 1);
});

test('install refuses a name another package owns', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  const otherRoot = await makeTemporaryDirectory(t);
  await writeTree(otherRoot, {
    'package.json': JSON.stringify({ name: 'other' }),
    'skills/alpha/SKILL.md': 'impostor',
  });
  await t.throwsAsync(
    store.install(parsePackageSource(otherRoot, home), otherRoot),
    { message: /already belongs to/ },
  );
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'alpha',
  );
});

test('install refuses to overwrite a resource the user authored', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await writeTree(home, { '.agents/skills/alpha/SKILL.md': 'mine' });
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /Refusing to overwrite/,
  });
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'mine',
  );
  t.false(await isFilePresent(path.join(home, '.agents/prompts/review.md')));
});

test('install refuses a symbolic link anywhere in a resource', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await fs.symlink(
    '/etc/passwd',
    path.join(packageRoot, 'skills/alpha/references/stolen'),
  );
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /not a regular file or directory/,
  });
  t.false(await isFilePresent(path.join(home, '.agents/skills/alpha')));
});

test('install refuses a declared directory reached through a link', async t => {
  const outside = await makeTemporaryDirectory(t);
  await writeTree(outside, { 'alpha/SKILL.md': 'outside' });
  const { source, store, packageRoot } = await makeFixture(t, {
    'package.json': JSON.stringify({
      name: 'sample',
      endo: { skills: ['./linked/skills'] },
    }),
  });
  await fs.mkdir(path.join(outside, 'skills'));
  await fs.rename(
    path.join(outside, 'alpha'),
    path.join(outside, 'skills/alpha'),
  );
  await fs.symlink(outside, path.join(packageRoot, 'linked'));
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /escapes the package/,
  });
});

test('install refuses a declared directory that does not exist', async t => {
  const { source, store, packageRoot } = await makeFixture(t, {
    'package.json': JSON.stringify({
      name: 'sample',
      endo: { skills: ['./absent'] },
    }),
  });
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /"endo\.skills" directory "\.\/absent" does not exist/,
  });
  t.deepEqual(await store.list(), []);
});

test('install refuses a skill name outside the agentskills alphabet', async t => {
  const { source, store, packageRoot } = await makeFixture(t, {
    'package.json': JSON.stringify({ name: 'sample' }),
    'skills/Not_Valid/SKILL.md': '',
  });
  await t.throwsAsync(store.install(source, packageRoot), {
    message: /invalid name/,
  });
});

test('install warns about a skill directory with no SKILL.md', async t => {
  const { source, store, packageRoot } = await makeFixture(t, {
    ...packageFiles,
    'skills/helpers/notes.md': '',
  });
  const { warnings, record } = await store.install(source, packageRoot);
  t.deepEqual(record.resources.skills, ['alpha']);
  t.regex(warnings[0], /helpers: it has no SKILL\.md/);
});

test('a failed ledger write restores the prior install', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  await writeTree(packageRoot, { 'skills/alpha/SKILL.md': 'alpha two' });
  // A directory at the staged path makes the ledger write fail last.
  const stagedPath = path.join(
    home,
    '.agents/endo-packages/packages.json.staged',
  );
  await fs.mkdir(stagedPath);
  await t.throwsAsync(store.install(source, packageRoot));
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'alpha',
  );
  t.true(await isFilePresent(path.join(home, '.agents/prompts/review.md')));
  await fs.rmdir(stagedPath);
  t.deepEqual(
    (await fs.readdir(path.join(home, '.agents/endo-packages'))).filter(name =>
      name.startsWith('staging-'),
    ),
    [],
    'the staging directory does not outlive the attempt',
  );
});

test('remove deletes only what the package installed', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await writeTree(home, { '.agents/skills/mine/SKILL.md': 'mine' });
  await store.install(source, packageRoot);
  await store.remove(source.id);
  t.false(await isFilePresent(path.join(home, '.agents/skills/alpha')));
  t.false(await isFilePresent(path.join(home, '.agents/prompts/review.md')));
  t.true(await isFilePresent(path.join(home, '.agents/skills/mine/SKILL.md')));
  t.deepEqual(await store.list(), []);
  await t.throwsAsync(store.remove(source.id), { message: /No package/ });
});

test('remove tolerates a resource the user already deleted', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  await fs.rm(path.join(home, '.agents/skills/alpha'), { recursive: true });
  await store.remove(source.id);
  t.deepEqual(await store.list(), []);
});

test('a ledger naming a path outside the scope is refused', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await writeTree(home, { 'precious/SKILL.md': 'precious' });
  await store.install(source, packageRoot);
  const ledgerPath = path.join(home, '.agents/endo-packages/packages.json');
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  ledger.packages[0].resources.skills = ['../../precious'];
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  await t.throwsAsync(store.remove(source.id), { message: /invalid name/ });
  t.true(await isFilePresent(path.join(home, 'precious/SKILL.md')));
});

test('disabling moves resources out of discovery and enabling restores them', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  const skill = path.join(home, '.agents/skills/alpha/SKILL.md');
  await store.setEnabled(source.id, false);
  t.false(await isFilePresent(skill));
  t.false((await store.list())[0].enabled);

  await store.install(source, packageRoot);
  t.false(await isFilePresent(skill), 'a reinstall stays disabled');

  await store.setEnabled(source.id, true);
  t.is(await fs.readFile(skill, 'utf8'), 'alpha');
  t.true((await store.list())[0].enabled);
});

test('setting the state a package already has changes nothing', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  await store.setEnabled(source.id, true);
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'alpha',
  );
  t.true((await store.list())[0].enabled);
});

test('enabling a package that is not installed is refused', async t => {
  const { store } = await makeFixture(t);
  await t.throwsAsync(store.setEnabled('npm:absent', true), {
    message: /No package "npm:absent" is installed/,
  });
});

test('enabling refuses to overwrite a resource authored meanwhile', async t => {
  const { home, source, store, packageRoot } = await makeFixture(t);
  await store.install(source, packageRoot);
  await store.setEnabled(source.id, false);
  await writeTree(home, { '.agents/skills/alpha/SKILL.md': 'mine' });
  await t.throwsAsync(store.setEnabled(source.id, true), {
    message: /Refusing to overwrite/,
  });
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'mine',
  );
  t.false((await store.list())[0].enabled);
});

test('fetchPackage packs npm sources with lifecycle scripts off', async t => {
  const temporaryDirectory = await makeTemporaryDirectory(t);
  const body = Buffer.from('{"name":"sample"}');
  const archive = await compress(
    Buffer.concat([
      tarFileHeader('package/package.json', body.byteLength),
      body,
      tarFilePadding(body.byteLength),
      tarEndMarker(),
    ]),
  );
  const calls = [];
  const runCommand = async (command, commandArguments, options) => {
    calls.push([command, commandArguments, options.cwd]);
    await fs.writeFile(
      path.join(temporaryDirectory, 'sample-1.0.0.tgz'),
      archive,
    );
    return { stdout: JSON.stringify([{ filename: 'sample-1.0.0.tgz' }]) };
  };
  const packageRoot = await fetchPackage(
    parsePackageSource('npm:sample@1.0.0', '/work'),
    temporaryDirectory,
    { runCommand },
  );
  t.deepEqual(calls, [
    [
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporaryDirectory,
        'sample@1.0.0',
      ],
      temporaryDirectory,
    ],
  ]);
  t.is(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    '{"name":"sample"}',
  );
});

test('fetchPackage clones git sources shallowly at the named reference', async t => {
  const temporaryDirectory = await makeTemporaryDirectory(t);
  const calls = [];
  const runCommand = async (command, commandArguments, options) => {
    calls.push([command, commandArguments, options.env.GIT_TERMINAL_PROMPT]);
    return { stdout: '' };
  };
  const packageRoot = await fetchPackage(
    parsePackageSource('git:github.com/user/repo@v1', '/work'),
    temporaryDirectory,
    { runCommand },
  );
  t.deepEqual(calls, [
    [
      'git',
      [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        'v1',
        '--',
        'https://github.com/user/repo',
        packageRoot,
      ],
      '0',
    ],
  ]);
});

test('extractPackageTarball keeps executable bits and strips the root', async t => {
  const workspace = await makeTemporaryDirectory(t);
  await writeTree(workspace, { 'package/skills/alpha/run.sh': '#!/bin/sh\n' });
  await fs.chmod(path.join(workspace, 'package/skills/alpha/run.sh'), 0o755);
  await execa('tar', ['-czf', 'package.tgz', 'package'], {
    cwd: workspace,
    env: { COPYFILE_DISABLE: '1' },
  });
  const destination = path.join(workspace, 'out');
  await extractPackageTarball(path.join(workspace, 'package.tgz'), destination);
  const { mode } = await fs.stat(path.join(destination, 'skills/alpha/run.sh'));
  // eslint-disable-next-line no-bitwise
  t.is(mode & 0o111, 0o111 & ~process.umask());
});

test('extractPackageTarball refuses a symbolic link', async t => {
  const workspace = await makeTemporaryDirectory(t);
  await fs.mkdir(path.join(workspace, 'package'));
  await fs.symlink('/etc/passwd', path.join(workspace, 'package/stolen'));
  await execa('tar', ['-czf', 'package.tgz', 'package'], {
    cwd: workspace,
    env: { COPYFILE_DISABLE: '1' },
  });
  await t.throwsAsync(
    extractPackageTarball(
      path.join(workspace, 'package.tgz'),
      path.join(workspace, 'out'),
    ),
    { message: /symbolic link/ },
  );
});

test('extractPackageTarball refuses a traversing entry', async t => {
  const workspace = await makeTemporaryDirectory(t);
  const archivePath = path.join(workspace, 'package.tgz');
  await fs.writeFile(
    archivePath,
    await compress(
      Buffer.concat([tarFileHeader('package/../../evil', 0), tarEndMarker()]),
    ),
  );
  await t.throwsAsync(
    extractPackageTarball(archivePath, path.join(workspace, 'a/out')),
    { message: /Invalid tar entry path segment/ },
  );
  t.false(await isFilePresent(path.join(workspace, 'evil')));
});

test('extractPackageTarball refuses a file beside the package root', async t => {
  const workspace = await makeTemporaryDirectory(t);
  const archivePath = path.join(workspace, 'package.tgz');
  await fs.writeFile(
    archivePath,
    await compress(
      Buffer.concat([tarFileHeader('package', 0), tarEndMarker()]),
    ),
  );
  await t.throwsAsync(
    extractPackageTarball(archivePath, path.join(workspace, 'out')),
    { message: /has no leading directory/ },
  );
});

const runEndo = async (commandArguments, { home, cwd = home }) =>
  execa(process.execPath, [endoBin, ...commandArguments], {
    cwd,
    env: { HOME: home, USERPROFILE: home },
    reject: false,
  });

test('the CLI installs, lists, disables, updates, and removes a package', async t => {
  const { home, packageRoot } = await makeFixture(t);
  const skill = path.join(home, '.agents/skills/alpha/SKILL.md');
  const id = `file:${packageRoot}`;

  const installed = await runEndo(['install', packageRoot], { home });
  t.is(installed.exitCode, 0, installed.stderr);
  t.regex(installed.stdout, /installed file:.* 1\.0\.0: 1 skills, 1 prompts/);
  t.true(await isFilePresent(skill));

  const listed = await runEndo(['list', 'packages', '--json'], { home });
  t.is(JSON.parse(listed.stdout)[0].id, id);
  t.regex((await runEndo(['config'], { home })).stdout, /\(enabled\)/);

  await runEndo(['config', 'disable', id], { home });
  t.false(await isFilePresent(skill));
  t.regex((await runEndo(['ls', 'packages'], { home })).stdout, /\(disabled\)/);
  await runEndo(['config', 'enable', id], { home });
  t.true(await isFilePresent(skill));

  await writeTree(packageRoot, { 'skills/alpha/SKILL.md': 'alpha two' });
  const updated = await runEndo(['update'], { home });
  t.is(updated.exitCode, 0, updated.stderr);
  t.is(await fs.readFile(skill, 'utf8'), 'alpha two');

  const removed = await runEndo(['remove', id], { home });
  t.is(removed.exitCode, 0, removed.stderr);
  t.false(await isFilePresent(skill));
  t.is((await runEndo(['list', 'packages'], { home })).stdout, '');
});

test('endo update leaves a pinned install alone', async t => {
  const { home, packageRoot } = await makeFixture(t);
  await runEndo(['install', packageRoot], { home });
  const ledgerPath = path.join(home, '.agents/endo-packages/packages.json');
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  ledger.packages[0].pinned = true;
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  await writeTree(packageRoot, { 'skills/alpha/SKILL.md': 'alpha two' });
  const updated = await runEndo(['update'], { home });
  t.regex(updated.stdout, /skipped file:.*: pinned/);
  t.is(
    await fs.readFile(path.join(home, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    'alpha',
  );
});

test('the CLI scopes to the current directory with --project', async t => {
  const { home, packageRoot } = await makeFixture(t);
  const project = await makeTemporaryDirectory(t);
  const installed = await runEndo(['install', '--project', packageRoot], {
    home,
    cwd: project,
  });
  t.is(installed.exitCode, 0, installed.stderr);
  t.true(await isFilePresent(path.join(project, '.agents/skills/alpha')));
  t.false(await isFilePresent(path.join(home, '.agents')));

  // The option precedes the subcommand here, on the parent `config` command.
  await runEndo(['config', '--project', 'disable', `file:${packageRoot}`], {
    home,
    cwd: project,
  });
  t.false(await isFilePresent(path.join(project, '.agents/skills/alpha')));
});

test('the CLI reports a refusal without a stack trace or a daemon', async t => {
  const home = await makeTemporaryDirectory(t);
  const refused = await runEndo(['install', 'bare-name'], { home });
  t.is(refused.exitCode, 1);
  t.regex(refused.stderr, /^endo: Unrecognized package source "bare-name"/m);
  t.notRegex(refused.stderr, /\n\s+at /);
  const absent = await runEndo(['remove', 'npm:absent'], { home });
  t.is(absent.exitCode, 1);
  t.regex(absent.stderr, /^endo: No package "npm:absent" is installed/m);
});

test('the CLI warns about skipped directories and pending kinds', async t => {
  const { home, packageRoot } = await makeFixture(t, {
    ...packageFiles,
    'skills/helpers/notes.md': '',
    'guests/agent.js': '',
  });
  const { stdout, stderr } = await runEndo(['install', packageRoot], { home });
  t.regex(stdout, /^installed /m);
  t.regex(stderr, /^endo: .*helpers: it has no SKILL\.md/m);
  t.regex(stderr, /^endo: .* also declares guests \(\.\/guests\)/m);
  t.notRegex(stderr, /also declares providers/);
});

test('the CLI refuses to update a package that is not installed', async t => {
  const home = await makeTemporaryDirectory(t);
  const refused = await runEndo(['update', 'npm:absent'], { home });
  t.is(refused.exitCode, 1);
  t.regex(refused.stderr, /^endo: No package "npm:absent" is installed/m);
});

test('the help screen advertises the package verbs', async t => {
  const home = await makeTemporaryDirectory(t);
  const { stdout } = await runEndo(['--help'], { home });
  t.regex(stdout, /Packages/);
  t.regex(stdout, /\binstall\b/);
  t.regex(stdout, /\bupdate\b/);
  t.regex(stdout, /\bconfig\b/);
});
