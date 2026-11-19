// @ts-check
// The shell tools `runCommand` and `inspectShell` (guest/session/
// environment.js `shellToolEntries`; m6-interfaces.md 3.8, A.3, D-M6-5):
// their place in the static table, site, descriptions and availability;
// `inspectShell` reaches `ShellPort.inspect`; staged arguments carry the
// content reader; calls of one round share one port ask; a stopped part
// answers `sessionStopped` without sending; a failure that is not a
// retired break is the call's error and drops the port. Over fakes built
// from the real guards (`_session-environment.js`).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { shellToolDescriptions } from '../../guest/lib/guards/session.js';
import { makeLabels } from '../../guest/session/labels.js';
import { makeRuntime } from '../../guest/session/runtime-parts.js';
import { toolTable } from '../../guest/session/tool-table.js';
import { shellToolEntries } from '../../guest/session/environment.js';
/* eslint-enable import/no-relative-packages */
import {
  commandArgs,
  drain,
  makeEnvironmentSession,
  makeFakeEnvironment,
  ok,
} from './_session-environment.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The environment part of a runtime whose services hold the fake's control.
 * @param {any} env
 */
const partWith = env =>
  /** @type {any} */ (
    makeRuntime({
      labels: makeLabels(),
      services: harden({ environment: env.control, shell: Far('Shell', {}) }),
      config: harden({}),
    })
  ).environment;

const ports = harden({
  writers: Far('BlobWriters', {}),
  content: Far('Content', {}),
});
const context = harden({ turn: Far('Turn', {}), generation: 1 });

test('two static entries right after the package entries, guest site, A.3 descriptions', t => {
  const names = toolTable.map(entry => entry.name);
  const at = names.indexOf('adoptTool');
  t.deepEqual(names.slice(at + 1, at + 3), ['runCommand', 'inspectShell']);
  t.deepEqual(
    shellToolEntries.map(entry => [entry.name, entry.site]),
    [
      ['runCommand', 'guest'],
      ['inspectShell', 'guest'],
    ],
  );
  t.is(shellToolEntries[0].describe(), shellToolDescriptions.runCommand);
  t.is(shellToolEntries[1].describe(), shellToolDescriptions.inspectShell);
  for (const entry of shellToolEntries) {
    t.notThrows(() => JSON.parse(entry.describe().parameters));
  }
});

test('offered with a Shell and the writers port only', t => {
  const shell = Far('Shell', {});
  for (const entry of shellToolEntries) {
    t.true(entry.available(ports, { shell }));
    t.false(entry.available(ports, {}), 'no shell');
    t.false(entry.available({ content: ports.content }, { shell }));
  }
});

test('inspectShell reaches ShellPort.inspect with the model JSON as text', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([{ name: 'inspectShell', args: '{}' }]);
  t.is(env.commands[0].method, 'inspect');
  t.is(env.commands[0].request.args, '{}');
  env.commands[0].kit.resolve(
    ok('{"allowedCommands":["git"],"timeoutMs":1000,"maxOutputBytes":65536}'),
  );
  await drain();
  t.deepEqual(s.results(), [
    '{"allowedCommands":["git"],"timeoutMs":1000,"maxOutputBytes":65536}',
  ]);
});

test('staged arguments carry the content reader; calls of one round share one port ask', async t => {
  const env = makeFakeEnvironment();
  const part = partWith(env);
  const staged = harden({
    blob: Far('Blob', {}),
    preview: '{"command":"cat"',
    bytes: 20_000,
  });
  const first = part.shell(false, { opId: 'o1', args: staged }, ports, context);
  const second = part.shell(
    false,
    { opId: 'o2', args: commandArgs('true') },
    ports,
    context,
  );
  await drain();
  t.deepEqual(env.sent('port'), [['port']]);
  t.is(env.commands[0].request.content, ports.content);
  t.is(env.commands[0].request.args, staged);
  t.false('content' in env.commands[1].request);
  env.commands[0].kit.resolve(ok('a'));
  env.commands[1].kit.resolve(ok('b'));
  t.deepEqual(await first, ok('a'));
  t.deepEqual(await second, ok('b'));
});

test('a stopped part answers sessionStopped and sends nothing', async t => {
  const env = makeFakeEnvironment();
  const part = partWith(env);
  const stopped = await part.beginStop();
  t.deepEqual(stopped, { state: 'stopped', supported: true });
  t.is(part.hooks.admit(), texts.sessionStopped);
  const outcome = await part.shell(
    false,
    { opId: 'o1', args: commandArgs('true') },
    ports,
    context,
  );
  t.deepEqual(outcome, { status: 'failed', text: texts.sessionStopped });
  t.deepEqual(env.sent('port', 'runCommand'), []);
});

test('a failure that is not a retired break is the error text; the port is asked again', async t => {
  const env = makeFakeEnvironment();
  const part = partWith(env);
  const failing = part.shell(
    false,
    { opId: 'o1', args: commandArgs('true') },
    ports,
    context,
  );
  await drain();
  env.commands[0].kit.reject(Error('Shell.exec: bad'));
  t.deepEqual(await failing, { status: 'failed', text: 'Shell.exec: bad' });
  const next = part.shell(true, { opId: 'o2', args: '{}' }, ports, context);
  await drain();
  t.is(env.sent('port').length, 2);
  env.commands[1].kit.resolve(ok('x'));
  t.deepEqual(await next, ok('x'));
});
