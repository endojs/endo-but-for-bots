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

  t.like(globals[0], {
    name: 'builderShell',
    declaration: { body: 'EndoShell' },
  });
  t.like(globals[1], {
    name: 'network',
    declaration: { body: 'HttpClient' },
  });
  t.like(globals[2], {
    name: 'upstream',
    declaration: { body: 'GitRemote' },
  });

  const prompt = formatGlobalDeclarations(globals);
  t.true(prompt.includes('declare const builderShell: EndoShell;'));
  t.true(prompt.includes('declare const network: HttpClient;'));
  t.true(prompt.includes('declare const upstream: GitRemote;'));
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

test('a compartment can evaluate code against fake capability globals', async t => {
  // Build the descriptors with the real factories under test, so this test
  // fails (rather than passing unaffected) if a factory is deleted, renamed,
  // or emits the wrong lexical name or declaration.
  const shellGlobal = makeShellGlobal({ name: 'shell' });
  const httpGlobal = makeHttpGlobal({ name: 'http' });
  const remoteGlobal = makeGitRemoteGlobal({ name: 'remote' });
  const globals = [shellGlobal, httpGlobal, remoteGlobal];

  const prompt = formatGlobalDeclarations(globals);
  t.true(prompt.includes('declare const shell: EndoShell;'));
  t.true(prompt.includes('declare const http: HttpClient;'));
  t.true(prompt.includes('declare const remote: GitRemote;'));

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
