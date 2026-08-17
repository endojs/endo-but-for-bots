// @ts-nocheck

import os from 'os';
import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';
import { fc } from '@fast-check/ava';

import {
  collectHttpOrigin,
  httpMkArgumentsFromOptions,
  makeHttpClientPolicy,
  normalizeHttpClientOrigin,
  parsePolicyModeFlag,
  parsePositiveIntegerFlag,
} from '../src/http-mk-policy.js';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

// Isolated daemon context so this test file does not collide with
// concurrent CLI tests (see formula-collection.test.js for the same
// pattern).
const testRoot = path.join(dirname, 'tmp', 'endo-http-mk');
const endoEnv = {
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  XDG_RUNTIME_DIR: path.join(testRoot, 'run'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  ENDO_SOCK: path.join(os.tmpdir(), `endo-http-mk-${process.pid}.sock`),
  ENDO_ADDR: '127.0.0.1:0',
};

for (const [key, value] of Object.entries(endoEnv)) {
  process.env[key] = value;
}

// --- Pure policy assembly (no daemon) -------------------------------------

test('makeHttpClientPolicy assembles a minimal record and omits unset knobs', t => {
  const policy = makeHttpClientPolicy({
    allowedOrigins: ['https://api.example.com'],
  });
  t.deepEqual(policy, { allowedOrigins: ['https://api.example.com'] });
  t.false('maxRequestsPerMinute' in policy);
  t.false('maxResponseBytes' in policy);
  t.false('policyMode' in policy);
});

test('makeHttpClientPolicy includes each guard knob only when supplied', t => {
  const policy = makeHttpClientPolicy({
    allowedOrigins: ['https://a.example', 'https://b.example'],
    maxRequestsPerMinute: 30,
    maxResponseBytes: 2048,
    policyMode: 'tofu-auto',
  });
  t.deepEqual(policy, {
    allowedOrigins: ['https://a.example', 'https://b.example'],
    maxRequestsPerMinute: 30,
    maxResponseBytes: 2048,
    policyMode: 'tofu-auto',
  });
});

test('makeHttpClientPolicy preserves origin order and arity', t => {
  const origins = [
    'https://c.example',
    'https://a.example',
    'https://b.example',
  ];
  const { allowedOrigins } = makeHttpClientPolicy({ allowedOrigins: origins });
  t.deepEqual(allowedOrigins, origins);
});

test('normalizeHttpClientOrigin canonicalizes browser-copied origin forms', t => {
  // Trailing slash, explicit default port, and mixed-case host all canonicalize
  // to the exact serialization the daemon compares against verbatim.
  t.is(
    normalizeHttpClientOrigin('https://Example.com/'),
    'https://example.com',
  );
  t.is(
    normalizeHttpClientOrigin('https://example.com:443'),
    'https://example.com',
  );
  t.is(
    normalizeHttpClientOrigin('http://example.com:80'),
    'http://example.com',
  );
});

test('makeHttpClientPolicy normalizes each origin through the assembler', t => {
  // Pin the load-bearing seam a user actually reaches (mk -> makeHttpClientPolicy
  // -> provideHttpClient): the assembler must apply normalizeHttpClientOrigin to
  // every entry, not merely accept already-canonical origins. Removing the
  // `.map(normalizeHttpClientOrigin)` in makeHttpClientPolicy reddens this — the
  // three tests that feed already-canonical origins do not.
  const policy = makeHttpClientPolicy({
    allowedOrigins: ['https://Example.com/', 'https://api.example.com:443'],
  });
  t.deepEqual(policy, {
    allowedOrigins: ['https://example.com', 'https://api.example.com'],
  });
});

test('normalizeHttpClientOrigin refuses a path/query/fragment/userinfo origin', t => {
  // These are dropped by `URL.prototype.origin`; silently widening them to the
  // whole host on a capability-minting verb would teach a false confinement, so
  // they are refused locally by flag name rather than normalized away.
  for (const raw of [
    'https://api.example.com/v1/things?q=1#frag',
    'https://api.example.com/v1',
    'https://api.example.com/?q=1',
    'https://api.example.com/#frag',
    'https://user:pass@api.example.com',
  ]) {
    t.throws(() => normalizeHttpClientOrigin(raw), {
      message: /must be a bare origin/,
    });
  }
});

// The docstring makes a canonical-form/idempotence claim
// (`normalize(normalize(x)) === normalize(x)`); pin it over the whole accepted
// origin space rather than the three hand-picked examples above.
const arbAcceptedOrigin = fc
  .record({
    scheme: fc.constantFrom('http', 'https'),
    host: fc.domain(),
    port: fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: undefined }),
    trailingSlash: fc.boolean(),
  })
  .map(
    ({ scheme, host, port, trailingSlash }) =>
      `${scheme}://${host}${port === undefined ? '' : `:${port}`}${
        trailingSlash ? '/' : ''
      }`,
  );

test('normalizeHttpClientOrigin is idempotent over accepted origins', async t => {
  await fc.assert(
    fc.property(arbAcceptedOrigin, raw => {
      const once = normalizeHttpClientOrigin(raw);
      // A second pass over the already-canonical form is a fixed point.
      t.is(normalizeHttpClientOrigin(once), once);
    }),
  );
});

// A %-encoded segment led by a literal non-dot character. Encoding strips any
// `/`, `?`, `#`, `@`, or `:` delimiter so each builder below produces exactly
// the suffix kind it names; the leading `x` keeps a path segment from ever being
// a lone `.`/`..` dot-segment, which `URL` path-normalization collapses back to
// the bare-origin root (`http://h/..` -> `http://h`) — a correct acceptance,
// not a reject case.
const arbSuffixSegment = fc
  .string({ minLength: 1 })
  .map(suffix => `x${encodeURIComponent(suffix)}`);

const arbRejectedOrigin = fc
  .record({
    scheme: fc.constantFrom('http', 'https'),
    host: fc.domain(),
    segment: arbSuffixSegment,
    kind: fc.constantFrom('path', 'query', 'fragment', 'userinfo'),
  })
  .map(({ scheme, host, segment, kind }) => {
    switch (kind) {
      case 'path':
        return `${scheme}://${host}/${segment}`;
      case 'query':
        return `${scheme}://${host}?${segment}`;
      case 'fragment':
        return `${scheme}://${host}#${segment}`;
      case 'userinfo':
        return `${scheme}://${segment}@${host}`;
      default:
        throw new Error(`unreachable: ${kind}`);
    }
  });

test('normalizeHttpClientOrigin refuses any path/query/fragment/userinfo suffix', async t => {
  // The refusal branch is the security boundary the docstring calls out —
  // silently widening a suffixed origin to the whole host would teach a false
  // confinement — so pin that no suffixed input slips through as a bare origin.
  await fc.assert(
    fc.property(arbRejectedOrigin, raw => {
      t.throws(() => normalizeHttpClientOrigin(raw), {
        message: /must be a bare origin/,
      });
    }),
  );
});

test('makeHttpClientPolicy rejects an empty origin allowlist', t => {
  t.throws(() => makeHttpClientPolicy({ allowedOrigins: [] }), {
    message: /at least one --origin/,
  });
  t.throws(() => makeHttpClientPolicy({ allowedOrigins: undefined }), {
    message: /at least one --origin/,
  });
});

test('normalizeHttpClientOrigin rejects a non-http(s) scheme and non-URL', t => {
  t.throws(() => normalizeHttpClientOrigin('ftp://example.com'), {
    message: /must use the http: or https: scheme/,
  });
  t.throws(() => normalizeHttpClientOrigin('not a url'), {
    message: /not a valid http\(s\) origin/,
  });
});

test('parsePositiveIntegerFlag accepts a positive integer, names the flag on reject', t => {
  const parse = parsePositiveIntegerFlag('--max-response-bytes');
  t.is(parse('1024'), 1024);
  for (const bad of ['abc', '', '0', '-5', '1.5', '0x10', '1e3', '1_000']) {
    t.throws(
      () => parse(bad),
      { message: /--max-response-bytes/ },
      `rejects ${JSON.stringify(bad)}`,
    );
  }
});

test('parsePositiveIntegerFlag pins the safe-integer boundary and the trim path', t => {
  const parse = parsePositiveIntegerFlag('--max-response-bytes');
  // MAX_SAFE_INTEGER is admissible; every bad value above rejects at the regex,
  // so without these the Number.isSafeInteger guard is dead coverage — a
  // syntactically valid numeral that Number() silently rounds must still reject.
  t.is(parse('9007199254740991'), 9007199254740991);
  t.throws(() => parse('9007199254740993'), {
    message: /must be a safe integer/,
  });
  t.throws(() => parse('1'.repeat(400)), { message: /must be a safe integer/ });
  // The trim() branch: surrounding whitespace is accepted.
  t.is(parse('  1024  '), 1024);
});

// --- Flag wiring (commander coercers and opt routing) ----------------------

test('collectHttpOrigin accumulates repeated --origin values in flag order', t => {
  // Commander threads the previous accumulator as the second argument; a
  // last-wins regression (returning [value]) would collapse a multi-origin
  // allowlist to only the final --origin.
  let collectedOrigins = collectHttpOrigin('https://a.example', undefined);
  collectedOrigins = collectHttpOrigin('https://b.example', collectedOrigins);
  collectedOrigins = collectHttpOrigin('https://c.example', collectedOrigins);
  t.deepEqual(collectedOrigins, [
    'https://a.example',
    'https://b.example',
    'https://c.example',
  ]);
});

test('parsePolicyModeFlag accepts admissible modes and names the flag on reject', t => {
  t.is(parsePolicyModeFlag('strict'), 'strict');
  t.is(parsePolicyModeFlag('tofu-auto'), 'tofu-auto');
  t.throws(() => parsePolicyModeFlag('tofu-prompt'), {
    message: /--policy-mode must be strict or tofu-auto/,
  });
});

test('httpMkArgumentsFromOptions routes each commander option to the matching httpMk arg', t => {
  // Pins the option-key routing: a swapped destructure (e.g. binding the byte
  // cap to the request cap) would sail through the daemon-driven test, which
  // only checks the echoed pet name.
  t.deepEqual(
    httpMkArgumentsFromOptions('my-http', {
      as: 'host-a',
      origin: ['https://a.example', 'https://b.example'],
      maxRequestsPerMinute: 30,
      maxResponseBytes: 2048,
      policyMode: 'tofu-auto',
      acknowledgeUnbounded: true,
    }),
    {
      name: 'my-http',
      allowedOrigins: ['https://a.example', 'https://b.example'],
      maxRequestsPerMinute: 30,
      maxResponseBytes: 2048,
      policyMode: 'tofu-auto',
      acknowledgeUnbounded: true,
      agentNames: 'host-a',
    },
  );
});

test('httpMkArgumentsFromOptions leaves unset knobs undefined', t => {
  const mkArguments = httpMkArgumentsFromOptions('x', {
    origin: ['https://a.example'],
  });
  t.deepEqual(mkArguments.allowedOrigins, ['https://a.example']);
  t.is(mkArguments.maxRequestsPerMinute, undefined);
  t.is(mkArguments.maxResponseBytes, undefined);
  t.is(mkArguments.policyMode, undefined);
  t.is(mkArguments.acknowledgeUnbounded, undefined);
  t.is(mkArguments.agentNames, undefined);
});

// --- Help surface ----------------------------------------------------------

test('endo --help advertises the http subcommand', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  t.regex(stdout, /\bhttp\b/, 'help output should mention the http subcommand');
});

test('endo http --help advertises mk', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'http', '--help']);
  t.regex(stdout, /Usage: endo http/);
  t.regex(stdout, /\bmk\b/);
});

test('endo http mk --help describes the policy surface and the tofu-auto widening', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'http',
    'mk',
    '--help',
  ]);
  t.regex(stdout, /--origin/);
  t.regex(stdout, /Usage: endo http mk/);
  t.regex(stdout, /<name>/);
  // The tofu-auto widening must be visible on the minting surface itself, not
  // only in the design doc: it auto-allows any first-seen origin.
  t.regex(stdout, /tofu-auto/);
  t.regex(stdout, /AUTO-ALLOWS|auto-allow/i);
});

// --- Local flag validation via the CLI (no daemon) -------------------------

test('endo http mk rejects a non-integer numeric flag locally', async t => {
  const error = await t.throwsAsync(
    execa(process.execPath, [
      endoBin,
      'http',
      'mk',
      'x',
      '--origin',
      'https://a.example',
      '--max-response-bytes',
      'abc',
    ]),
  );
  t.regex(error.stderr, /--max-response-bytes/);
});

test('endo http mk rejects an unknown --policy-mode locally', async t => {
  const error = await t.throwsAsync(
    execa(process.execPath, [
      endoBin,
      'http',
      'mk',
      'x',
      '--origin',
      'https://a.example',
      '--policy-mode',
      'tofu-prompt',
    ]),
  );
  t.regex(error.stderr, /--policy-mode must be strict or tofu-auto/);
});

test('endo http mk refuses tofu-auto without --acknowledge-unbounded locally', async t => {
  // The unbounded, unrevocable grant must be gated by an explicit flag, not by
  // help prose alone; the refusal is local, before any daemon connect.
  const error = await t.throwsAsync(
    execa(process.execPath, [
      endoBin,
      'http',
      'mk',
      'x',
      '--origin',
      'https://a.example',
      '--policy-mode',
      'tofu-auto',
    ]),
  );
  t.regex(error.stderr, /--acknowledge-unbounded/);
});

// --- Daemon-driven registration -------------------------------------------

// Invoke the CLI under test via an absolute path derived from import.meta.url
// so it cannot bind to a globally installed `endo` on the runner's PATH.
const endo = (...args) =>
  execa(process.execPath, [endoBin, ...args], { cwd: dirname });

test.serial(
  'endo http mk registers the client pet name under an origin policy',
  async t => {
    await endo('purge', '-f');
    await endo('start');
    try {
      // A literal origin suffices — normalizeHttpClientPolicy only validates the
      // origin's shape and never dials it, so no listening server is needed.
      const result = await endo(
        'http',
        'mk',
        'my-http',
        '--origin',
        'http://127.0.0.1:8080',
        '--origin',
        'https://api.example.com',
      );
      const lines = result.stdout.split('\n').filter(Boolean);
      t.deepEqual(
        lines,
        ['my-http'],
        'mk should print the pet name it registered',
      );

      // The name is reachable via endo list.
      const list = await endo('list');
      t.regex(list.stdout, /\bmy-http\b/);
    } finally {
      await endo('purge', '-f');
    }
  },
);

test.serial('endo http mk rejects an empty origin allowlist', async t => {
  // Never reaches the daemon: the local guard rejects before connecting.
  const error = await t.throwsAsync(endo('http', 'mk', 'no-origins'));
  t.regex(error.stderr, /at least one --origin/);
});

test.serial(
  'endo http mk rebinds an occupied name to the new client',
  async t => {
    // The rebind claim (a second mk on the same name repoints it, dropping the
    // old client's reference) is security-relevant and was pinned nowhere.
    await endo('purge', '-f');
    await endo('start');
    try {
      await endo('http', 'mk', 'feed', '--origin', 'https://a.example');
      const rebind = await endo(
        'http',
        'mk',
        'feed',
        '--origin',
        'https://b.example',
      );
      t.deepEqual(
        rebind.stdout.split('\n').filter(Boolean),
        ['feed'],
        'the rebind should echo the same pet name',
      );
      // The name resolves to exactly one client entry after the rebind.
      const list = await endo('list');
      const feedLines = list.stdout
        .split('\n')
        .filter(line => /\bfeed\b/.test(line));
      t.is(feedLines.length, 1, 'the name should denote a single client');
    } finally {
      await endo('purge', '-f');
    }
  },
);
