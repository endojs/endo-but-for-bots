// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  buildArgv,
  assertConfinedArgv,
  assertPinnedVersion,
  assertRequiredFlags,
  assertPinnedValueFlags,
  assertSingleOccurrenceFlags,
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

test('buildArgv emits all nine required flags, empty-value flags, and never --resume', t => {
  const argv = buildArgv(spec());
  assertConfinedArgv(argv); // does not throw
  for (const flag of REQUIRED_FLAGS) t.true(argv.includes(flag), flag);
  t.is(argv[argv.indexOf('--tools') + 1], '');
  t.is(argv[argv.indexOf('--setting-sources') + 1], '');
  t.false(argv.includes('--resume'));
  t.false(argv.includes('--continue'));
});

test('buildArgv asks for the stream-json transcript the launch seam parses', t => {
  const argv = buildArgv(spec());
  t.is(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  t.true(argv.includes('--verbose'));
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
  t.throws(() => assertPinnedVersion('2.1.281'), { message: /!= pinned/ });
  t.throws(() => assertPinnedVersion('2.1.279'), { message: /!= pinned/ });
  // The previous pin, measured before 2.1.280's live re-run.
  t.throws(() => assertPinnedVersion('2.1.232'), { message: /!= pinned/ });
});

test('buildArgv pins the permission mode to dontAsk with no prompting', t => {
  const argv = buildArgv(spec());
  t.is(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  t.is(argv[argv.indexOf('--permission-prompts') + 1], 'none');
});

test('a missing, altered, or repeated pinned-value flag is refused', t => {
  for (const flag of [
    '--permission-mode',
    '--permission-prompts',
    '--tools',
    '--setting-sources',
  ]) {
    const missing = conformingArgv();
    missing.splice(missing.indexOf(flag), 2);
    t.throws(() => assertPinnedValueFlags(missing), { message: /missing/ });

    const altered = conformingArgv();
    altered[altered.indexOf(flag) + 1] = 'bypassPermissions';
    t.throws(() => assertConfinedArgv(altered), { message: /must carry/ });

    // A later occurrence would override the pinned one.
    const repeated = [...conformingArgv(), flag, 'bypassPermissions'];
    t.throws(() => assertConfinedArgv(repeated), { message: /more than once/ });
  }
});

test('an argv without --settings is refused', t => {
  // `enabledPlugins` (disabling the builtin plugins) rides only on --settings.
  const argv = conformingArgv();
  argv.splice(argv.indexOf('--settings'), 2);
  t.throws(() => assertConfinedArgv(argv), { message: /--settings/ });
});

test('an argv without --mcp-config is refused', t => {
  const argv = conformingArgv();
  argv.splice(argv.indexOf('--mcp-config'), 2);
  t.throws(() => assertConfinedArgv(argv), { message: /--mcp-config/ });
});

test('a bare token spliced after a variadic flag value is refused', t => {
  // 2.1.280 measured: `--tools "" Bash` yields `"tools":["Bash"]`, and
  // `--mcp-config legit.json attacker.json` loads both configs.
  for (const [flag, bare] of [
    ['--tools', 'Bash'],
    ['--mcp-config', '/tmp/attacker.json'],
    ['--settings', '/tmp/attacker.json'],
    ['--setting-sources', 'user'],
    ['--permission-mode', 'bypassPermissions'],
    ['--permission-prompts', 'ask'],
  ]) {
    const argv = conformingArgv();
    argv.splice(argv.indexOf(flag) + 2, 0, bare);
    t.throws(() => assertConfinedArgv(argv), { message: /bare token/ }, flag);
  }
});

test('property: any bare token after a checked flag value is refused', t => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        '--tools',
        '--setting-sources',
        '--permission-mode',
        '--permission-prompts',
        '--settings',
        '--mcp-config',
        '--allowedTools',
        '--disallowedTools',
      ),
      fc.oneof(
        fc.constant('--'),
        fc.string().filter(s => !s.startsWith('--')),
      ),
      (flag, bare) => {
        const argv = conformingArgv();
        argv.splice(argv.indexOf(flag) + 2, 0, bare);
        t.throws(() => assertConfinedArgv(argv), { message: /bare token/ });
      },
    ),
    { numRuns: 200 },
  );
});

test('a trailing --tools Bash cannot re-open the built-in set', t => {
  const argv = [...conformingArgv(), '--tools', 'Bash'];
  t.throws(() => assertConfinedArgv(argv), { message: /more than once/ });
});

test('a trailing --settings or --mcp-config cannot substitute another file', t => {
  for (const flag of ['--settings', '--mcp-config']) {
    const argv = [...conformingArgv(), flag, '/tmp/attacker.json'];
    t.throws(
      () => assertConfinedArgv(argv),
      { message: /more than once/ },
      flag,
    );
    t.throws(
      () => assertSingleOccurrenceFlags(argv),
      { message: /more than once/ },
      flag,
    );
  }
});

test('property: any repeat of --settings or --mcp-config is refused', t => {
  fc.assert(
    fc.property(
      fc.constantFrom('--settings', '--mcp-config'),
      fc.string(),
      fc.nat(),
      (flag, value, position) => {
        const argv = conformingArgv();
        const at = position % (argv.length + 1);
        argv.splice(at, 0, flag, value);
        t.throws(() => assertConfinedArgv(argv));
      },
    ),
  );
});

// property: nine-flag spawn-refusal predicate

const conformingArgv = () => [...buildArgv(spec())];

test('property: dropping any of the nine required flags refuses', t => {
  fc.assert(
    fc.property(
      fc.subarray([...REQUIRED_FLAGS], {
        minLength: 0,
        maxLength: REQUIRED_FLAGS.length - 1,
      }),
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
        t.throws(() => assertPinnedValueFlags(argv), { message: /must carry/ });
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

test('a value-less --settings or --mcp-config is refused', t => {
  for (const flag of ['--settings', '--mcp-config']) {
    const atEnd = conformingArgv();
    atEnd.splice(atEnd.indexOf(flag), 2);
    atEnd.push(flag);
    t.throws(
      () => assertConfinedArgv(atEnd),
      { message: /must carry a value/ },
      flag,
    );

    const beforeFlag = conformingArgv();
    beforeFlag.splice(beforeFlag.indexOf(flag) + 1, 1);
    t.throws(
      () => assertConfinedArgv(beforeFlag),
      { message: /must carry a value/ },
      flag,
    );
  }
});

test('a repeated or bare-token-trailed --allowedTools / --disallowedTools is refused', t => {
  for (const flag of ['--allowedTools', '--disallowedTools']) {
    const repeated = conformingArgv();
    repeated.push(flag, 'mcp__attacker__steal');
    t.throws(
      () => assertConfinedArgv(repeated),
      { message: /more than once/ },
      flag,
    );

    const trailed = conformingArgv();
    trailed.splice(trailed.indexOf(flag) + 2, 0, 'mcp__attacker__steal');
    t.throws(
      () => assertConfinedArgv(trailed),
      { message: /bare token/ },
      flag,
    );
  }
});

test('property: an --flag=value token for any checked flag is refused', t => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        ...REQUIRED_FLAGS,
        '--permission-mode',
        '--permission-prompts',
        '--allowedTools',
        '--disallowedTools',
      ),
      fc.string(),
      fc.nat(),
      (flag, value, position) => {
        const argv = conformingArgv();
        const at = position % (argv.length + 1);
        argv.splice(at, 0, `${flag}=${value}`);
        t.throws(() => assertConfinedArgv(argv));
      },
    ),
  );
});

test('an empty --settings, --mcp-config, --allowedTools, or --disallowedTools value is refused', t => {
  for (const flag of [
    '--settings',
    '--mcp-config',
    '--allowedTools',
    '--disallowedTools',
  ]) {
    const argv = conformingArgv();
    argv[argv.indexOf(flag) + 1] = '';
    t.throws(
      () => assertConfinedArgv(argv),
      { message: /must carry a value/ },
      flag,
    );
  }
});

test('an argv without --allowedTools or --disallowedTools is refused', t => {
  for (const flag of ['--allowedTools', '--disallowedTools']) {
    const argv = conformingArgv();
    argv.splice(argv.indexOf(flag), 2);
    t.throws(() => assertConfinedArgv(argv), { message: /missing/ }, flag);
  }
});

test('a bare -- end-of-options token is refused anywhere', t => {
  // After `--`, an option parser reads `/tmp/attacker.json` as a positional.
  const trailing = conformingArgv();
  trailing.splice(
    trailing.indexOf('--mcp-config') + 2,
    0,
    '--',
    '/tmp/attacker.json',
  );
  t.throws(() => assertConfinedArgv(trailing), { message: /bare token/ });

  const atEnd = [...conformingArgv(), '--', 'prompt text'];
  t.throws(() => assertConfinedArgv(atEnd), { message: /end-of-options/ });
});

test('a presence-only flag in another flag value slot is refused', t => {
  for (const flag of [
    '--bare',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ]) {
    for (const host of ['--model', '--max-turns', '--output-format']) {
      // Drop the standalone flag and hide it as `host`'s value instead.
      const argv = conformingArgv();
      argv.splice(argv.indexOf(flag), 1);
      argv.push(host, flag);
      t.throws(() => assertConfinedArgv(argv), undefined, `${host} ${flag}`);
    }
    const repeated = [...conformingArgv(), flag];
    t.throws(
      () => assertConfinedArgv(repeated),
      { message: /more than once/ },
      flag,
    );
  }
});

test('a flag-shaped --model, --max-turns, or --output-format value is refused', t => {
  for (const flag of ['--model', '--max-turns', '--output-format']) {
    const argv = conformingArgv();
    argv.splice(argv.indexOf(flag) + 1, 0, '--verbose');
    t.throws(
      () => assertConfinedArgv(argv),
      { message: /must carry a value/ },
      flag,
    );
  }
});

test('property: a repeat carrying the identical value is refused too', t => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        '--tools',
        '--setting-sources',
        '--permission-mode',
        '--permission-prompts',
        '--settings',
        '--mcp-config',
        '--allowedTools',
        '--disallowedTools',
      ),
      flag => {
        const argv = conformingArgv();
        argv.push(flag, argv[argv.indexOf(flag) + 1]);
        t.throws(() => assertConfinedArgv(argv), { message: /more than once/ });
      },
    ),
  );
});
