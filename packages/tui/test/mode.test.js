// @ts-check

// Tests for the mode-selection contract used by `endor`'s
// `-i`/`--interactive` flag.  When `endor` parses the flag, it calls
// `make({ mode: 'interactive', ... })` or `make({ mode: 'unix', ... })`
// (the latter is the default).  The wrapper must expose the inspector
// capability + log sink appropriate for the selected mode and must
// never fall back to `console.*` as a stdout writer.

import test from '@endo/ses-ava/test.js';

import {
  make,
  makeNoopInspector,
  makeStubInspector,
  makeInspectorLogSink,
} from '../index.js';

test('default mode is unix', async t => {
  const tui = await make();
  t.is(tui.mode, 'unix');
});

test('explicit unix mode supplies a no-op inspector', async t => {
  const tui = await make({ mode: 'unix' });
  t.is(tui.mode, 'unix');
  // The no-op inspector accepts records silently rather than throwing,
  // so unconditional library logging is safe in UNIX mode.
  await t.notThrowsAsync(() =>
    tui.inspector.appendLog({ level: 'info', message: 'hello' }),
  );
});

test('interactive mode supplies a stub inspector', async t => {
  const tui = await make({ mode: 'interactive' });
  t.is(tui.mode, 'interactive');
  // The stub throws "not implemented" to signal that the real Rust
  // host has not wired the capability yet.
  await t.throwsAsync(
    () => tui.inspector.appendLog({ level: 'info', message: 'hello' }),
    { message: /not implemented/ },
  );
});

test('log sink is silent by default in unix mode', async t => {
  const tui = await make({ mode: 'unix' });
  // The silent sink accepts every level without throwing or routing
  // through console.*.  The contract is that it is a capability, not
  // a side-channel onto stdout/stderr.
  t.notThrows(() => tui.log.info('hello'));
  t.notThrows(() => tui.log.error('boom', { err: 'x' }));
});

test('silent log sink supports message grouping', async t => {
  const tui = await make({ mode: 'unix' });
  // Grouping is part of the LogSink contract; the silent sink
  // accepts group/groupCollapsed/groupEnd like any other level.
  t.notThrows(() => {
    tui.log.group('request', { id: 7 });
    tui.log.info('step one');
    tui.log.groupCollapsed('detail');
    tui.log.debug('inner');
    tui.log.groupEnd();
    tui.log.groupEnd();
  });
});

test('inspector log sink forwards grouping to the inspector', async t => {
  // Drive a recording inspector directly so we can assert the sink
  // maps console-style grouping onto the inspector's group/groupEnd
  // verbs and drops omitted optional arguments.
  const calls = [];
  const recorder = {
    help: () => 'recorder',
    appendLog: async record => {
      calls.push(['appendLog', record]);
    },
    group: async record => {
      calls.push(['group', record]);
    },
    groupEnd: async () => {
      calls.push(['groupEnd']);
    },
    appendSample: async () => undefined,
    open: async () => undefined,
    close: async () => undefined,
  };
  const sink = makeInspectorLogSink(recorder);

  sink.group('outer', { id: 1 });
  sink.info('hello');
  sink.groupCollapsed('inner');
  sink.groupEnd();
  sink.groupEnd();

  // Fire-and-forget sends resolve on the microtask queue.
  await null;

  t.deepEqual(calls, [
    ['group', { label: 'outer', fields: { id: 1 } }],
    ['appendLog', { level: 'info', message: 'hello' }],
    ['group', { label: 'inner', collapsed: true }],
    ['groupEnd'],
    ['groupEnd'],
  ]);
  // `group('outer', …)` carries no `collapsed`, and `info('hello')`
  // carries no `fields`; both omit the undefined optional key rather
  // than forwarding it (which the Exo guard would reject).
  t.false('collapsed' in calls[0][1]);
  t.false('fields' in calls[1][1]);
});

test('makeStubInspector exposes the grouping verbs', async t => {
  const inspector = makeStubInspector();
  // eslint-disable-next-line no-underscore-dangle
  const methods = await inspector.__getMethodNames__();
  t.true(methods.includes('group'));
  t.true(methods.includes('groupEnd'));
});

test('no-op inspector accepts grouping silently', async t => {
  const inspector = makeNoopInspector();
  await t.notThrowsAsync(() =>
    inspector.group({ label: 'g', collapsed: true }),
  );
  await t.notThrowsAsync(() => inspector.groupEnd());
});

test('caller-supplied inspector overrides mode default', async t => {
  const inspector = makeNoopInspector();
  const tui = await make({ mode: 'interactive', inspector });
  t.is(tui.inspector, inspector);
});

test('makeStubInspector returns a TuiInspector remotable', async t => {
  const inspector = makeStubInspector();
  // eslint-disable-next-line no-underscore-dangle
  const methods = await inspector.__getMethodNames__();
  t.true(methods.includes('appendLog'));
  t.true(methods.includes('appendSample'));
  t.true(methods.includes('open'));
  t.true(methods.includes('close'));
  t.true(methods.includes('help'));
});
