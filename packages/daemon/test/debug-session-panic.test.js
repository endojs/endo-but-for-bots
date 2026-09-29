// @ts-check

/**
 * @file The `<panic>` wire message in DebugSession and the Debugger exo.
 *
 * A panic is uncatchable by category, so the XS worker reports it with its
 * own `<panic kind="...">` element instead of a `<break>`, whatever the
 * exception-break mode, and stops at the panic site until released
 * (designs/ironhorse-panic.md § Debugger Interaction). The XML fixtures
 * below have the shape `fxDebugPanic` in `rust/endo/xsnap/xsnap-debug.c`
 * echoes.
 */

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeLoopback } from '@endo/captp';

import { makeDebugSession } from '../src/debug-session.js';
import { makeDebugger } from '../src/debugger.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Yield to the event loop so CapTP dispatches complete. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const STACK_OVERFLOW_PANIC =
  '\r\n<xsbug><panic kind="stack-overflow" path="/app.js" line="2">' +
  '# Panic: JavaScript stack overflow!\n</panic></xsbug>\r\n';

const PANIC_FRAMES =
  '\r\n<xsbug><frames>' +
  '<frame name="recurse" value="@1" path="/app.js" line="2"/>' +
  '<frame name="recurse" value="@2" path="/app.js" line="2"/>' +
  '<frame name="deliver" value="@3" path="/app.js" line="6"/>' +
  '</frames></xsbug>\r\n';

const makeTestSession = () => {
  /** @type {string[]} */
  const outbound = [];
  const session = makeDebugSession(bytes => {
    outbound.push(textDecoder.decode(bytes));
  });
  /** @param {string} xml */
  const feed = xml => session.feedXml(textEncoder.encode(xml));
  return { session, outbound, feed };
};

test('a <panic> element becomes a PanicEvent, not a break', t => {
  const { session, feed } = makeTestSession();
  /** @type {unknown[]} */
  const panics = [];
  /** @type {unknown[]} */
  const breaks = [];
  session.onPanic(event => panics.push(event));
  session.onBreak(event => breaks.push(event));

  t.false(session.isPanicked());
  feed(STACK_OVERFLOW_PANIC);

  const expected = {
    kind: 'stack-overflow',
    path: '/app.js',
    line: 2,
    message: '# Panic: JavaScript stack overflow!\n',
  };
  t.deepEqual(panics, [expected]);
  t.deepEqual(breaks, []);
  t.deepEqual(session.getLastPanic(), expected);
  t.is(session.getLastBreak(), null);
  t.true(session.isPanicked());
  // Stopped at the panic site.
  t.true(session.isBroken());
});

test('a panic is reported under setExceptionBreakMode("none")', t => {
  const { session, outbound, feed } = makeTestSession();
  session.setExceptionBreakMode('none');
  t.true(outbound.some(s => s.includes('path="exceptions"')));
  t.false(outbound.some(s => s.includes('panic')));

  feed(STACK_OVERFLOW_PANIC);
  t.is(session.getLastPanic()?.kind, 'stack-overflow');
});

// The Coda's panic-on-reference-error option (designs/ironhorse-panic.md
// § Coda) turns an engine-raised ReferenceError into a panic, so it arrives
// as `<panic kind="reference-error">`, not as an exception break, whatever
// the exception-break mode.
const REFERENCE_ERROR_PANIC =
  '\r\n<xsbug><panic kind="reference-error" path="/app.js" line="4">' +
  '# Panic: get x: not initialized yet\n</panic></xsbug>\r\n';

for (const mode of /** @type {const} */ (['none', 'uncaught', 'all'])) {
  test(`a reference-error panic is a panic under setExceptionBreakMode("${mode}")`, t => {
    const { session, feed } = makeTestSession();
    session.setExceptionBreakMode(mode);
    /** @type {import('../src/types.js').PanicEvent[]} */
    const panics = [];
    session.onPanic(event => panics.push(event));
    feed(REFERENCE_ERROR_PANIC);
    t.deepEqual(panics, [
      {
        kind: 'reference-error',
        path: '/app.js',
        line: 4,
        message: '# Panic: get x: not initialized yet\n',
      },
    ]);
    t.true(session.isPanicked());
  });
}

test('frames at the panic site remain inspectable', async t => {
  const { session, feed } = makeTestSession();
  feed(STACK_OVERFLOW_PANIC);
  const framesP = session.getFrames();
  feed(PANIC_FRAMES);
  const frames = await framesP;
  t.deepEqual(
    frames.map(frame => frame.name),
    ['recurse', 'recurse', 'deliver'],
  );
});

test('a step that runs into a panic rejects instead of hanging', async t => {
  const { session, feed } = makeTestSession();
  const stepP = session.step();
  feed(
    '\r\n<xsbug><panic kind="meter-abort" path="/app.js" line="7">' +
      '# Panic: too much computation!\n</panic></xsbug>\r\n',
  );
  await t.throwsAsync(stepP, {
    message: 'Worker panicked (meter-abort) at /app.js:7',
  });
  t.is(session.getLastPanic()?.kind, 'meter-abort');
});

test('releasing a panic stop clears broken but not panicked', t => {
  const { session, outbound, feed } = makeTestSession();
  feed(STACK_OVERFLOW_PANIC);
  session.go();
  t.true(outbound.some(s => s.includes('<go/>')));
  t.false(session.isBroken());
  // The worker is torn down after release; it never resumes.
  t.true(session.isPanicked());
});

test('an unrecognized element degrades to a no-op, never a break', t => {
  // How a consumer that predates <panic> sees it: the parser ignores the
  // element and its text, reports no break, and keeps parsing.
  const { session, feed } = makeTestSession();
  /** @type {unknown[]} */
  const breaks = [];
  session.onBreak(event => breaks.push(event));

  feed(
    '\r\n<xsbug><quake kind="stack-overflow" path="/app.js" line="2">' +
      '# Quake!\n</quake></xsbug>\r\n',
  );
  t.deepEqual(breaks, []);
  t.false(session.isBroken());

  feed('\r\n<xsbug><break path="/app.js" line="3"># Break!\n</break></xsbug>');
  t.is(breaks.length, 1);
  t.is(session.getLastBreak()?.line, 3);
});

test('isPanicked and getLastPanic over CapTP', async t => {
  const { session, feed } = makeTestSession();
  const { makeFar } = makeLoopback('debugger-panic-test');
  /** @type {any} */
  const remote = await makeFar(makeDebugger(session));

  t.false(await E(remote).isPanicked());
  t.is(await E(remote).getLastPanic(), null);

  feed(STACK_OVERFLOW_PANIC);
  await flush();

  t.true(await E(remote).isPanicked());
  t.true(await E(remote).isBroken());
  t.deepEqual(await E(remote).getLastPanic(), {
    kind: 'stack-overflow',
    path: '/app.js',
    line: 2,
    message: '# Panic: JavaScript stack overflow!\n',
  });
  t.is(await E(remote).getLastBreak(), null);
});
