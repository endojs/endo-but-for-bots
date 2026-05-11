// @ts-check

// Tests for the mode-selection contract used by `endor`'s
// `-i`/`--interactive` flag.  When `endor` parses the flag, it calls
// `make({ mode: 'interactive', ... })` or `make({ mode: 'unix', ... })`
// (the latter is the default).  The wrapper must expose the inspector
// capability + log sink appropriate for the selected mode and must
// never fall back to `console.*` as a stdout writer.

import test from '@endo/ses-ava/test.js';

import { make, makeNoopInspector, makeStubInspector } from '../index.js';

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
