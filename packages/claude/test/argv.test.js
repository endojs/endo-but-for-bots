// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  buildArgv,
  assertConfinedArgv,
  assertPinnedVersion,
  assertRequiredFlags,
  assertEmptyValueFlags,
  REQUIRED_FLAGS,
  PINNED_CLI_VERSION,
} from '../src/argv.js';

const spec = () => ({
  mcpConfigPath: '/run/endo-claude-spawn/tag/mcp.json',
  settingsPath: '/run/endo-claude-spawn/tag/settings.json',
  allowList: ['mcp__endo__writeText', 'mcp__endo__list'],
  model: 'claude-opus-4-8',
  maxTurns: 16,
});

test('buildArgv emits all five required flags, empty-value flags, and never --resume', t => {
  const argv = buildArgv(spec());
  assertConfinedArgv(argv); // does not throw
  for (const flag of REQUIRED_FLAGS) t.true(argv.includes(flag), flag);
  t.is(argv[argv.indexOf('--tools') + 1], '');
  t.is(argv[argv.indexOf('--setting-sources') + 1], '');
  t.false(argv.includes('--resume'));
  t.false(argv.includes('--continue'));
});

test('buildArgv delivers the prompt at NO index (stdin only)', t => {
  // The prompt is not even a parameter to buildArgv, so it cannot appear.
  // Construction invariant: the last token is the `-p` print flag, never a prompt
  // positional. A value comparison against the prompt would false-fire (a prompt
  // equal to a legit token like `mcp__endo__list` matches a value element), which
  // is exactly why the invariant is stated as construction, not comparison.
  const argv = buildArgv(spec());
  t.is(argv[argv.length - 1], '-p');
  t.true(argv.includes('--allowedTools'));
  // The only occurrences of the allow-list token are as the value of
  // --allowedTools, never as a trailing positional.
  t.is(
    argv.indexOf('mcp__endo__writeText,mcp__endo__list'),
    argv.indexOf('--allowedTools') + 1,
  );
});

test('buildArgv joins variadic values into single comma tokens (no swallowable run)', t => {
  const argv = buildArgv(spec());
  const allowAt = argv.indexOf('--allowedTools');
  t.is(argv[allowAt + 1], 'mcp__endo__writeText,mcp__endo__list');
  // The token after the allow-list value is a flag, not a stray positional.
  t.is(argv[allowAt + 2], '--model');
});

test('assertPinnedVersion fails closed on any mismatch', t => {
  t.notThrows(() => assertPinnedVersion(PINNED_CLI_VERSION));
  t.throws(() => assertPinnedVersion('2.1.233'), { message: /!= pinned/ });
  t.throws(() => assertPinnedVersion('2.1.231'), { message: /!= pinned/ });
});

// --- property: five-flag spawn-refusal predicate -------------------------

const conformingArgv = () => [...buildArgv(spec())];

test('property: dropping any of the five required flags refuses', t => {
  fc.assert(
    fc.property(
      fc.subarray([...REQUIRED_FLAGS], { minLength: 0, maxLength: 4 }),
      fc.array(fc.string(), { maxLength: 3 }),
      (present, noise) => {
        // A strict subset of the required flags plus arbitrary noise -> refuse.
        const argv = [...present, ...noise];
        t.throws(() => assertRequiredFlags(argv));
      },
    ),
    { numRuns: 200 },
  );
});

test('property: the complete required set (as built) is accepted', t => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      t.notThrows(() => assertConfinedArgv(conformingArgv()));
    }),
    { numRuns: 20 },
  );
});

test('property: a non-empty --tools / --setting-sources value is refused (presence-only would admit --tools Bash)', t => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.constantFrom('--tools', '--setting-sources'),
      (value, flag) => {
        const argv = conformingArgv();
        argv[argv.indexOf(flag) + 1] = value; // clobber the empty value
        t.throws(() => assertEmptyValueFlags(argv));
      },
    ),
    { numRuns: 200 },
  );
});

test('property: a version generator that differs from the pin always refuses', t => {
  fc.assert(
    fc.property(
      fc.string().filter(v => v !== PINNED_CLI_VERSION),
      v => {
        t.throws(() => assertPinnedVersion(v));
      },
    ),
    { numRuns: 200 },
  );
});
