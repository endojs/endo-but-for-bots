// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import { makeCompartmentEvaluate } from '../src/code-mode/compartment.js';
import { formatGlobalDeclarations } from '../src/code-mode/declarations.js';
import { makeGitGlobal } from '../src/code-mode-globals/git.js';
import { makeGitRemoteGlobal } from '../src/code-mode-globals/git-remote.js';
import { makeHttpGlobal } from '../src/code-mode-globals/http.js';
import { makeShellGlobal } from '../src/code-mode-globals/shell.js';

test('capability global factories preserve custom lexical names and pet paths', t => {
  const globals = [
    makeShellGlobal({ name: 'builderShell', petName: ['repo', 'shell'] }),
    makeHttpGlobal({ name: 'network', petName: 'http-client' }),
    makeGitRemoteGlobal({ name: 'upstream', petName: ['repo', 'origin'] }),
  ];
  const [shellGlobal, httpGlobal, remoteGlobal] = globals;
  if (
    shellGlobal === undefined ||
    httpGlobal === undefined ||
    remoteGlobal === undefined
  ) {
    throw new Error('expected all capability globals');
  }
  const shellDeclaration = shellGlobal.declaration;
  const httpDeclaration = httpGlobal.declaration;
  const remoteDeclaration = remoteGlobal.declaration;
  if (
    shellDeclaration === undefined ||
    httpDeclaration === undefined ||
    remoteDeclaration === undefined
  ) {
    throw new Error('expected all capability global declarations');
  }

  t.like(shellGlobal, { name: 'builderShell' });
  t.like(httpGlobal, { name: 'network' });
  t.like(remoteGlobal, { name: 'upstream' });
  t.true(shellDeclaration.body.includes('exec:'));
  t.true(httpDeclaration.body.includes('fetch:'));
  t.true(remoteDeclaration.body.includes('push:'));
  t.true(httpDeclaration.aux?.includes('type HttpResponse =') ?? false);
  t.true(
    remoteDeclaration.aux?.includes('type RemoteOperationResult =') ?? false,
  );

  const prompt = formatGlobalDeclarations(globals);
  t.true(prompt.includes('declare const builderShell: {'));
  t.true(prompt.includes('declare const network: {'));
  t.true(prompt.includes('declare const upstream: {'));
});

test('custom Git names rewrite recursive declaration references', t => {
  const global = makeGitGlobal({ name: 'repoGit' });
  const { declaration } = global;
  if (declaration === undefined) {
    throw new Error('expected Git global declaration');
  }

  t.true(declaration.body.includes('typeof repoGit'));
  t.false(declaration.body.includes('typeof git'));

  const prompt = formatGlobalDeclarations([global]);
  t.true(prompt.includes('declare const repoGit: {'));
  t.true(prompt.includes('typeof repoGit'));
});

test('history Git global explains rebase control and conflict recovery', t => {
  const global = makeGitGlobal({
    name: 'git',
    historyRewrite: true,
  });
  const { description } = global;
  if (description === undefined) {
    throw new Error('history Git global must include a description');
  }
  for (const phrase of [
    'start',
    'continue',
    'abort',
    'skip',
    'conflicts',
    'stage 2',
    'stage 3',
    'inverted',
  ]) {
    t.true(description.includes(phrase));
  }
  const { declaration } = global;
  if (declaration === undefined) {
    throw new Error('history Git global must include a declaration');
  }
  t.false(description.includes('status('));
  t.false(declaration.aux?.includes('status:') ?? false);
  t.false(declaration.body.includes('status:'));
});

test('read/write Git global teaches status-path staging', t => {
  const { description } = makeGitGlobal({ name: 'git' });
  if (description === undefined) {
    throw new Error('read/write Git global must include a description');
  }
  t.true(description.includes('status({ untracked: "normal" })'));
  t.true(description.includes('add([row.path])'));
});

test('a compartment can evaluate code against fake capability globals', async t => {
  // Build the descriptors with the real factories under test, so this test
  // fails (rather than passing unaffected) if a factory is deleted, renamed,
  // or emits the wrong lexical name or declaration.
  const shellGlobal = makeShellGlobal({ name: 'shell' });
  const httpGlobal = makeHttpGlobal({ name: 'http' });
  const remoteGlobal = makeGitRemoteGlobal({ name: 'remote' });
  const globals = [shellGlobal, httpGlobal, remoteGlobal];

  const prompt = formatGlobalDeclarations(globals);
  t.true(prompt.includes('declare const shell: {'));
  t.true(prompt.includes('declare const http: {'));
  t.true(prompt.includes('declare const remote: {'));

  const shell = Far('FakeShell', {
    exec: async (command, args) =>
      harden({ stdout: `${command}:${args.join(',')}`, exitCode: 0 }),
  });
  const response = Far('FakeHttpResponse', {
    status: () => 200,
  });
  const http = Far('FakeHttpClient', {
    fetch: async () => response,
  });
  const remote = Far('FakeGitRemote', {
    inspect: async () => harden({ name: 'origin' }),
  });
  const evaluate = makeCompartmentEvaluate({
    endowments: {
      E,
      [shellGlobal.name]: shell,
      [httpGlobal.name]: http,
      [remoteGlobal.name]: remote,
    },
  });

  const result = await evaluate({
    source: `(async () => {
  const response = await E(http).fetch('https://example.com');
  return {
    shell: await E(shell).exec('echo', ['ok']),
    status: await E(response).status(),
    remote: await E(remote).inspect(),
  };
})()`,
    globals,
  });

  t.deepEqual(result, {
    shell: { stdout: 'echo:ok', exitCode: 0 },
    status: 200,
    remote: { name: 'origin' },
  });
});
