// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makePodmanStartupCommand,
  makePodmanStartupGate,
} from '../src/podman-startup-gate.js';

/** @import { ExecutionContext } from 'ava' */

/**
 * @param {ExecutionContext} t
 * @param {string[]} args
 * @param {string} [shell]
 */
const start = (t, args, shell = '/bin/sh') => {
  const child = spawn(shell, args, { env: {}, stdio: 'pipe' });
  const finished = new Promise(resolve => child.once('close', resolve));
  t.teardown(async () => {
    child.kill();
    await finished;
  });
  return { child, finished };
};

for (const shell of ['/bin/sh', '/bin/dash']) {
  test(`startup command preserves guest argv, environment and first stdin on ${shell}`, async t => {
    t.timeout(5000);
    const directory = await mkdtemp(join(tmpdir(), 'endo-startup-gate-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const effect = join(directory, 'started');
    const commandPath = join(directory, 'command=task');
    // Use an actual executable containing '='. env must not consume its name
    // as another assignment, and every user-controlled string stays data.
    await writeFile(
      commandPath,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.argv[2], 'started');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(3),value:process.env.TEST_VALUE,input})));`,
      { mode: 0o700 },
    );
    const value = 'space " quote \' dollar $() equals=a\nnext';
    const applicationArgs = ['a b', '"; exit 7', 'a=b', 'line\nnext'];
    const command = makePodmanStartupCommand(
      ['command=task', effect, ...applicationArgs],
      { PATH: directory, TEST_VALUE: value },
    );
    t.deepEqual(command.createArgs, ['--unsetenv-all', '--entrypoint=/bin/sh']);
    const { child, finished } = start(t, [...command.argv], shell);
    const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
    await gate.ready;
    await t.throwsAsync(readFile(effect), { code: 'ENOENT' });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    await gate.release();
    t.is(gate.release(), gate.release());
    child.stdout.resume();
    child.stdin.end('first application bytes\nsecond line\n');
    await finished;
    const text = output.map(chunk => new TextDecoder().decode(chunk)).join('');
    t.deepEqual(JSON.parse(text), {
      argv: applicationArgs,
      value,
      input: 'first application bytes\nsecond line\n',
    });
    t.is(await readFile(effect, 'utf8'), 'started');
  });
}

test('startup command refuses env assignment ambiguity and exec options', t => {
  t.throws(() => makePodmanStartupCommand([], {}), {
    message: /requires a command/,
  });
  t.throws(() => makePodmanStartupCommand(['-c'], {}), {
    message: /explicit path/,
  });
  /** @type {Record<string,string>[]} */
  const invalidEnvironments = [
    { '': 'empty' },
    { 'a=b': 'value' },
    { A: '\0' },
  ];
  for (const env of invalidEnvironments) {
    t.throws(() => makePodmanStartupCommand(['/bin/true'], env), {
      message: /environment entry/,
    });
  }
});

test('startup gate accepts a partial marker without consuming workload stdout', async t => {
  t.timeout(5000);
  const { child, finished } = start(t, [
    '-c',
    "printf endo-sandbox; sleep 0.02; printf '%s\\n' -ready-v1; IFS= read -r release; printf application",
  ]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  await gate.ready;
  const output = [];
  child.stdout.on('data', chunk =>
    output.push(new TextDecoder().decode(chunk)),
  );
  await gate.release();
  child.stdout.resume();
  await finished;
  t.is(output.join(''), 'application');
});

/**
 * Each refusal is observed from the child's output or close, so those rows
 * get the deadline a slow CI runner needs to spawn a shell; only the script
 * that blocks forever is refused by the deadline itself, and it keeps a short
 * one.
 * @type {ReadonlyArray<readonly [string, RegExp, number]>}
 */
const refusedScripts = harden([
  ['printf wrong', /Unexpected native startup output/, 2000],
  [
    "printf 'endo-sandbox-ready-v1\\nextra'",
    /Unexpected native startup output/,
    2000,
  ],
  ['exit 0', /startup gate closed/, 2000],
  ['IFS= read -r unused', /startup gate timed out/, 50],
]);
for (const [script, message, timeoutMs] of refusedScripts) {
  test(`startup gate refuses ${script}`, async t => {
    t.timeout(5000);
    const { child } = start(t, ['-c', script]);
    const gate = makePodmanStartupGate(child, { timeoutMs });
    await t.throwsAsync(gate.ready, { message });
    await t.throwsAsync(gate.release(), { message });
  });
}

test('cancel(undefined) fences a ready gate and observes later stream errors', async t => {
  t.timeout(5000);
  const command = makePodmanStartupCommand(['/bin/echo', 'forbidden'], {});
  const { child } = start(t, [...command.argv]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  await gate.ready;
  gate.cancel(undefined);
  await gate.release().then(
    () => t.fail('Cancelled gate released'),
    reason => t.is(reason, undefined),
  );
  child.stdin.emit('error', Error('late stdin failure'));
  child.stdout.emit('error', Error('late stdout failure'));
  child.emit('error', Error('late process failure'));
});

test('cancel during a pending release rejects before the write callback', async t => {
  t.timeout(5000);
  const command = makePodmanStartupCommand(['/bin/echo', 'forbidden'], {});
  const { child } = start(t, [...command.argv]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  await gate.ready;
  child.stdin.cork();
  const release = gate.release();
  await Promise.resolve();
  const reason = Error('cancel pending release');
  gate.cancel(reason);
  await t.throwsAsync(release, { is: reason });
  child.stdin.destroy();
});

test('failed release write remains failed and stream errors stay observed', async t => {
  t.timeout(5000);
  const command = makePodmanStartupCommand(['/bin/echo', 'forbidden'], {});
  const { child } = start(t, [...command.argv]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  await gate.ready;
  child.stdin.destroy();
  await t.throwsAsync(gate.release(), { message: /destroyed/ });
  await t.throwsAsync(gate.release(), { message: /destroyed/ });
  child.stdout.emit('error', Error('late stdout failure'));
});

test("release issues its write in the caller's synchronous stretch once ready", async t => {
  t.timeout(5000);
  const command = makePodmanStartupCommand(
    ['/bin/sh', '-c', 'printf started; IFS= read -r finish'],
    {},
  );
  const { child } = start(t, [...command.argv]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  const originalWrite = child.stdin.write.bind(child.stdin);
  let issued = 0;
  Object.defineProperty(child.stdin, 'write', {
    /** @param {string} bytes @param {(error?: Error | null) => void} callback */
    value: (bytes, callback) => {
      issued += 1;
      return originalWrite(bytes, callback);
    },
  });
  // Before the marker, release must wait for it rather than write blindly.
  const early = gate.release();
  t.is(issued, 0);
  await gate.ready;
  t.is(issued, 1);
  await early;
  // A caller that checks its own admission state and then releases relies on
  // there being no microtask between that check and issuance.
  const { child: second } = start(t, [...command.argv]);
  const later = makePodmanStartupGate(second, { timeoutMs: 1000 });
  const secondWrite = second.stdin.write.bind(second.stdin);
  let secondIssued = 0;
  Object.defineProperty(second.stdin, 'write', {
    /** @param {string} bytes @param {(error?: Error | null) => void} callback */
    value: (bytes, callback) => {
      secondIssued += 1;
      return secondWrite(bytes, callback);
    },
  });
  await later.ready;
  const releasing = later.release();
  t.is(secondIssued, 1);
  await releasing;
  child.stdout.resume();
  second.stdout.resume();
});

test('release rejection after bytes reach the gate does not imply nonexecution', async t => {
  t.timeout(5000);
  const command = makePodmanStartupCommand(
    ['/bin/sh', '-c', 'printf started; IFS= read -r finish'],
    {},
  );
  const { child } = start(t, [...command.argv]);
  const gate = makePodmanStartupGate(child, { timeoutMs: 1000 });
  await gate.ready;
  const originalWrite = child.stdin.write.bind(child.stdin);
  /** @type {(() => void) | undefined} */
  let acknowledge;
  Object.defineProperty(child.stdin, 'write', {
    /** @param {string} bytes @param {(error?: Error | null) => void} callback */
    value: (bytes, callback) =>
      originalWrite(bytes, error => {
        acknowledge = () => callback(error);
      }),
  });
  const ran = new Promise(resolve => child.stdout.once('data', resolve));
  child.stdout.resume();
  const releasing = gate.release();
  await ran;
  const reason = Error('cancel after bytes were delivered');
  gate.cancel(reason);
  await t.throwsAsync(releasing, { is: reason });
  // Only the caller's retained process cleanup can stop this running workload.
  t.is(child.exitCode, null);
  acknowledge?.();
  await t.throwsAsync(gate.release(), { is: reason });
});
