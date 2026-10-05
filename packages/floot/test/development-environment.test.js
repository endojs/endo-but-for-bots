// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import {
  provideDevelopmentEnvironment,
  lookupEnvironmentAdmin,
  makeDevelopmentTools,
} from '../src/development-environment.js';

const fixture = () => {
  const hostStore = new Map();
  const guestStore = new Map();
  const publications = [];
  let refuseCopy = false;
  const shell = Far('Shell', {
    inspect: () =>
      harden({
        allowedCommands: ['sh'],
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      }),
    exec: () =>
      harden({
        stdout: 'ok',
        stderr: 'failed',
        exitCode: 7,
        signal: null,
        truncated: false,
      }),
  });
  const mount = Far('Workspace');
  guestStore.set('workspace', Far('Git', { worktree: () => mount }));
  const guest = Far('Guest', {
    has: name => guestStore.has(name),
    lookup: name => guestStore.get(name),
  });
  hostStore.set('session-agent-test', guest);
  hostStore.set('environment-runner', Far('Runner'));
  const host = Far('Host', {
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    remove: name => hostStore.delete(name),
    provideEnvironment(runner, workspace, adminName, shellName, recipe) {
      publications.push({ runner, workspace, recipe });
      hostStore.set(adminName, Far('Admin', { stop: () => undefined }));
      hostStore.set(shellName, shell);
    },
    copy([source], [agentName, name]) {
      if (refuseCopy) throw Error('Copy failed');
      if (agentName !== 'session-agent-test') throw Error('Wrong guest');
      guestStore.set(name, hostStore.get(source));
    },
  });
  return {
    host,
    guest,
    hostStore,
    guestStore,
    publications,
    mount,
    shell,
    refuse: value => {
      refuseCopy = value;
    },
  };
};
const provision = f =>
  provideDevelopmentEnvironment({
    host: f.host,
    guest: f.guest,
    agentName: 'session-agent-test',
    id: 'test',
    networkPolicy: 'public-internet',
  });

test('development publication retains private admin, shares exact workspace, and is passive on revival', async t => {
  const f = fixture();
  await provision(f);
  await provision(f);
  t.is(f.publications.length, 1);
  t.is(f.publications[0].workspace, f.mount);
  t.is(f.publications[0].recipe.networkPolicy, 'public-internet');
  t.is(f.publications[0].recipe.policy.timeoutMs, 86_400_000);
  t.is(f.publications[0].recipe.policy.maxOutputBytes, 16 * 1024 * 1024);
  t.is(f.guestStore.get('shell'), f.shell);
  t.false(f.guestStore.has('environment-runner'));
  t.false(f.guestStore.has('admin'));
  t.true(f.hostStore.has('floot-environment-admin-test'));
  t.false(f.hostStore.has('floot-environment-shell-test'));
});

test('development shell limits are recorded in the recipe and never rewritten on revival', async t => {
  const f = fixture();
  const options = {
    host: f.host,
    guest: f.guest,
    agentName: 'session-agent-test',
    id: 'test',
    networkPolicy: 'public-internet',
  };
  await provideDevelopmentEnvironment({
    ...options,
    shellTimeoutMs: 123_000,
    shellOutputBytes: 4096,
  });
  await provideDevelopmentEnvironment({
    ...options,
    shellTimeoutMs: 456_000,
    shellOutputBytes: 8192,
  });
  t.is(f.publications.length, 1);
  t.is(f.publications[0].recipe.policy.timeoutMs, 123_000);
  t.is(f.publications[0].recipe.policy.maxOutputBytes, 4096);
});

test('failed Shell publication retries the same allocation; missing private admin never acknowledges cleanup', async t => {
  const f = fixture();
  f.refuse(true);
  await t.throwsAsync(provision(f), { message: 'Copy failed' });
  f.refuse(false);
  await provision(f);
  t.is(f.publications.length, 1);
  f.hostStore.delete('floot-environment-admin-test');
  await t.throwsAsync(provision(f), { message: /private admin is missing/ });
  await t.throwsAsync(
    lookupEnvironmentAdmin(f.host, 'test', { checkGuest: true }),
    { message: /private admin is missing/ },
  );
  t.is(
    await lookupEnvironmentAdmin(f.host, 'not-provisioned', {
      checkGuest: true,
    }),
    undefined,
  );
});

test('incomplete private publication refuses a new allocation', async t => {
  const f = fixture();
  f.hostStore.set('floot-environment-admin-test', Far('Admin'));
  await t.throwsAsync(provision(f), { message: /incomplete/ });
  t.is(f.publications.length, 0);
});

test('portable development tools validate named argv and retain nonzero exit as data', async t => {
  const f = fixture();
  const tools = makeDevelopmentTools(f.shell);
  t.deepEqual([...tools.keys()], ['runCommand', 'inspectShell']);
  const run = tools.get('runCommand');
  t.is(run.schema().function.name, 'runCommand');
  t.is(
    JSON.parse(
      await run.execute(harden({ command: 'sh', args: ['-c', 'exit 7'] })),
    ).exitCode,
    7,
  );
  await t.throwsAsync(run.execute(harden({ command: 'sh', args: 'exit 7' })));
  await t.throwsAsync(
    run.execute(harden({ command: 'sh', args: [], hostPath: '/' })),
  );
});
