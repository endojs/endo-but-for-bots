// @ts-check
// The session's `environment` part (guest/session/environment.js;
// m6-interfaces.md 3.8, 4.2, 4.4, 4.5, D-M6-5, D-M6-20): the ShellPort
// asked once per adapter incarnation; a retired break from it is the
// command's unknown outcome (the turn goes on) and the next call asks
// again; a refusal of `port()` fails the call; cancel settles the turn's
// shell calls and stops the environment (and sends nothing for a turn that
// never ran a command); recovery settles them quietly; emergency stop and
// resume, crank by crank: the hold, the cancel, the refusals before any
// write (enqueue, start, send-now), no claim while stopped even from a
// turn source, resume keeps the hold. Real session code over fakes built
// from the real guards (`_session-environment.js`).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  requiredParts,
  runtimeParts,
} from '../../guest/session/runtime-parts.js';
import { environmentPart } from '../../guest/session/environment.js';
/* eslint-enable import/no-relative-packages */
import {
  AT,
  commandArgs,
  drain,
  makeEnvironmentSession,
  makeFakeEnvironment,
  ok,
  requestId,
  retiredBreak,
} from './_session-environment.js';

/**
 * @param {any} t
 * @param {() => unknown} thunk
 * @param {string} message
 */
const refuses = (t, thunk, message) => t.throws(thunk, { message });

test('the part is in the table after packages, and required', t => {
  t.true(runtimeParts.includes(environmentPart));
  const names = runtimeParts.map(part => part.name);
  t.is(names.indexOf('environment'), names.indexOf('packages') + 1);
  t.true(requiredParts.includes('environment'));
});

test('the ShellPort is asked once per incarnation; the model JSON goes unparsed with the writers', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('true') }]);
  t.deepEqual(env.sent('port'), [['port']]);
  const [first] = env.commands;
  t.is(first.method, 'runCommand');
  t.is(first.request.args, commandArgs('true'));
  t.is(first.request.writers, s.ports.writers);
  t.false('content' in first.request, 'inline arguments need no reader');
  t.is(first.request.opId, textOf.opId('t1', 0, 0));
  first.kit.resolve(ok('{"stdout":"","exitCode":0}'));
  await drain();
  t.deepEqual(s.results(), ['{"stdout":"","exitCode":0}']);
  await s.closeTurn();
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('true') }]);
  t.is(env.sent('port').length, 1, 'the next turn reuses the port');
  t.is(env.commands.length, 2);
  env.commands[1].kit.resolve(ok('again'));
  await drain();
  t.deepEqual(s.results(), ['again']);
});

test('a runner restart: the command outcome is unknown, the turn goes on, the next call asks a new port', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('sleep', ['5']) }]);
  env.restartRunner();
  await drain();
  t.deepEqual(s.results(), [textOf.errorResult(texts.commandOutcomeUnknown)]);
  t.is(s.turnState(), 'running', 'not a restart of the turn (D-M6-5)');
  t.is(s.last().round, 1, 'the next round was sent');
  await s.closeTurn();
  t.is(s.turnState(), 'completed');
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('true') }]);
  t.is(env.sent('port').length, 2);
  t.is(env.commands[1].incarnation, 1);
  env.commands[1].kit.resolve(ok('fresh'));
  await drain();
  t.deepEqual(s.results(), ['fresh']);
});

test("a refused port() fails the call with the manager's text; nothing is sent; the next call asks again", async t => {
  const env = makeFakeEnvironment();
  env.refusePorts('This environment was released with its session');
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('true') }]);
  t.deepEqual(s.results(), [
    textOf.errorResult('This environment was released with its session'),
  ]);
  t.is(env.commands.length, 0);
  await s.closeTurn();
  env.refusePorts(undefined);
  await s.toolTurn([{ name: 'inspectShell', args: '{}' }]);
  t.is(env.sent('port').length, 2);
  t.is(env.commands[0].method, 'inspect');
});

test('cancel settles the shell calls with commandStopped and stops the environment; a late answer is ignored', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([
    { name: 'runCommand', args: commandArgs('sleep', ['600']) },
    { name: 'runCommand', args: commandArgs('sleep', ['600']) },
  ]);
  t.is(env.commands.length, 2);
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  t.is(s.turnState(), 'cancelled');
  t.deepEqual(s.results(), [
    textOf.errorResult(texts.commandStopped),
    textOf.errorResult(texts.commandStopped),
  ]);
  t.deepEqual(env.sent('stop'), [['stop']], 'one stop for the turn');
  env.commands[0].kit.resolve(ok('late'));
  await drain();
  t.deepEqual(s.results(), [
    textOf.errorResult(texts.commandStopped),
    textOf.errorResult(texts.commandStopped),
  ]);
});

test('cancel of a turn that never used the shell sends nothing to the environment', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  s.session.enqueueOnce(harden({ text: 'hi' }), requestId(), AT);
  await drain();
  s.session.getCurrentTurn().turn.cancel();
  await drain();
  t.is(s.turnState(), 'cancelled');
  t.deepEqual(env.log, []);
});

test('recovery settles the shell call quietly and drops the port; no stop is sent', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('sleep', ['5']) }]);
  s.leases[0].reject(retiredBreak());
  await drain();
  t.is(s.turnState(), 'outcome-unknown');
  t.deepEqual(s.results(), [texts.toolOutcomeUnknown]);
  t.deepEqual(env.sent('stop'), []);
  env.commands[0].kit.resolve(ok('late'));
  await drain();
  t.deepEqual(
    s.results(),
    [texts.toolOutcomeUnknown],
    'the late answer is ignored',
  );
  await s.toolTurn([{ name: 'runCommand', args: commandArgs('true') }]);
  t.is(env.sent('port').length, 2, 'the dropped port is asked again');
});

test('emergency stop, crank by crank: hold, cancel, stopping, then stopped; events in order', async t => {
  const env = makeFakeEnvironment({ holdStops: true });
  const s = await makeEnvironmentSession({ environment: env });
  t.deepEqual(s.session.getExecutionState(), {
    state: 'running',
    supported: true,
  });
  await s.toolTurn([
    { name: 'runCommand', args: commandArgs('sleep', ['600']) },
  ]);
  const answer = s.session.emergencyStop();
  // E1 (one crank once the guard delivered the call): stopping, hold,
  // cancel, the control's stop; E2 waits for the control.
  await drain();
  t.deepEqual(s.session.getExecutionState(), {
    state: 'stopping',
    supported: true,
  });
  t.is(s.session.listPending().hold?.reason, 'stopped');
  t.is(s.session.listPending().hold?.message, texts.holdStopped);
  t.deepEqual(env.sent('emergencyStop', 'stop'), [['emergencyStop']]);
  t.is(s.turnState(), 'cancelled');
  t.deepEqual(s.results(), [textOf.errorResult(texts.commandStopped)]);
  t.deepEqual(s.executionEvents(), ['stopping']);
  // E2: the control answered.
  env.stops[0].resolve(undefined);
  t.deepEqual(await answer, { state: 'stopped', supported: true });
  await drain();
  t.deepEqual(s.executionEvents(), ['stopping', 'stopped']);
  t.deepEqual(await s.session.emergencyStop(), {
    state: 'stopped',
    supported: true,
  });
  t.is(
    env.sent('emergencyStop').length,
    1,
    'a stopped session answers at once',
  );
});

test('a failed stop: stopIncomplete, the state stays stopping; resume refused; a retry stops', async t => {
  const env = makeFakeEnvironment({ holdStops: true });
  const s = await makeEnvironmentSession({ environment: env });
  const first = s.session.emergencyStop();
  await drain();
  env.stops[0].reject(Error('adapter gone'));
  await t.throwsAsync(first, { message: texts.stopIncomplete });
  t.is(s.session.getExecutionState().state, 'stopping');
  await t.throwsAsync(s.session.resume(), { message: texts.finishStopFirst });
  const retry = s.session.emergencyStop();
  await drain();
  env.stops[1].resolve(undefined);
  t.deepEqual(await retry, { state: 'stopped', supported: true });
  await drain();
  t.deepEqual(s.executionEvents(), [
    'stopping',
    'stopping',
    'stopping',
    'stopped',
  ]);
});

test('while stopped: enqueue, message enqueue, start and send-now refuse before any write', async t => {
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({ environment: env });
  // A turn runs and one entry waits behind it.
  s.session.enqueueOnce(harden({ text: 'first' }), requestId(), AT);
  const waiting = requestId();
  s.session.enqueueOnce(harden({ text: 'second' }), waiting, AT);
  await drain();
  const { entry } = s.session.listPending().entries[0];
  await s.session.emergencyStop();
  await drain();
  const before = s.session.listPending();
  const id = requestId();
  refuses(
    t,
    () => s.session.enqueueOnce(harden({ text: 'third' }), id, AT),
    texts.sessionStopped,
  );
  refuses(
    t,
    () => s.session.enqueueMessageOnce(harden({ text: 'fourth' }), id, AT, []),
    texts.sessionStopped,
  );
  refuses(
    t,
    () => s.session.startTurn(harden({ text: 'fifth' }), AT),
    texts.sessionStopped,
  );
  refuses(t, () => entry.sendNow(), texts.sessionStopped);
  await drain();
  t.is(s.session.getSubmissionReceipt(id), undefined, 'no receipt written');
  t.deepEqual(s.session.listPending(), before, 'entries and hold unchanged');
  t.is(s.session.getCurrentTurn(), undefined, 'no turn claimed');
});

test('a turn source is never claimed while stopped; resume keeps the hold; a new message releases it', async t => {
  let asked = 0;
  const source = harden({
    name: 'probe',
    make: () =>
      harden({
        hooks: harden({
          nextTurn: () => {
            asked += 1;
            return harden({ text: 'from the source', at: AT });
          },
        }),
      }),
  });
  const env = makeFakeEnvironment();
  const s = await makeEnvironmentSession({
    environment: env,
    parts: harden([...runtimeParts, source]),
  });
  // The source started a turn when the session was idle; cancel it, stop.
  s.session.getCurrentTurn()?.turn.cancel();
  await drain();
  const stopped = s.session.emergencyStop();
  await stopped;
  await drain();
  const settledTurns = s.session.getHistoryPage().turns.length;
  asked = 0;
  // Every claim path while stopped: a settle, an enqueue attempt.
  t.throws(() => s.session.enqueueOnce(harden({ text: 'x' }), requestId(), AT));
  await drain();
  t.is(s.session.getCurrentTurn(), undefined);
  t.is(asked, 0, 'claimNext does not even ask the source');
  t.is(s.session.getHistoryPage().turns.length, settledTurns);
  // Resume: running, the hold stays (R4-56), nothing is replayed.
  t.deepEqual(await s.session.resume(), { state: 'running', supported: true });
  t.deepEqual(env.sent('resume'), [['resume']]);
  t.is(s.session.listPending().hold?.reason, 'stopped');
  t.is(s.session.getCurrentTurn(), undefined);
  t.deepEqual(await s.session.resume(), { state: 'running', supported: true });
  t.is(
    env.sent('resume').length,
    1,
    'resume of a running session sends nothing',
  );
  // A new message releases the hold and starts.
  s.session.enqueueOnce(harden({ text: 'after' }), requestId(), AT);
  await drain();
  t.is(s.session.listPending().hold, undefined);
  t.truthy(s.session.getCurrentTurn());
  t.deepEqual(s.executionEvents(), [
    'stopping',
    'stopped',
    'running',
    'running',
  ]);
});

test('without an environment: unsupported, stop refused, nothing refused at admission', async t => {
  const s = await makeEnvironmentSession();
  t.deepEqual(s.session.getExecutionState(), {
    state: 'running',
    supported: false,
  });
  await t.throwsAsync(s.session.emergencyStop(), {
    message: texts.noEnvironmentToStop,
  });
  t.is(s.session.listPending().hold, undefined, 'no hold was set');
  t.deepEqual(await s.session.resume(), { state: 'running', supported: false });
  s.session.enqueueOnce(harden({ text: 'hi' }), requestId(), AT);
  await drain();
  t.truthy(s.session.getCurrentTurn());
  t.false(
    s.last().tools.some((/** @type {any} */ d) => d.name === 'runCommand'),
  );
});
