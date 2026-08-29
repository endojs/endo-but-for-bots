// @ts-nocheck

// `http-mk-policy.js` imports `q` from `@endo/errors`, which requires the
// SES assert globals to be installed before it loads; lock down first, matching
// `list-grouping.test.js`. This must precede every other import.
import '@endo/init/debug.js';

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

test('normalizeHttpClientOrigin punycodes a non-ASCII (IDN) host', t => {
  // The call-site comment and design doc claim IDN-punycode canonicalization,
  // but every other origin test feeds ASCII-only hosts (fc.domain() included),
  // so the punycode path was pinned nowhere. A Unicode host and its already-
  // punycoded form must both land on the same canonical ASCII serialization,
  // and the case-fold must survive the transcription.
  t.is(
    normalizeHttpClientOrigin('https://exämple.com'),
    'https://xn--exmple-cua.com',
  );
  t.is(
    normalizeHttpClientOrigin('https://EXÄMPLE.com/'),
    'https://xn--exmple-cua.com',
  );
  t.is(
    normalizeHttpClientOrigin('https://xn--exmple-cua.com'),
    'https://xn--exmple-cua.com',
  );
});

test('normalizeHttpClientOrigin canonicalizes an IPv6 literal host', t => {
  // An IPv6 literal keeps its brackets and strips only the scheme's default
  // port, exactly as a named host does; a non-default port is retained.
  t.is(normalizeHttpClientOrigin('https://[::1]:8080'), 'https://[::1]:8080');
  t.is(normalizeHttpClientOrigin('https://[::1]:443'), 'https://[::1]');
  t.is(
    normalizeHttpClientOrigin('https://[2001:db8::1]/'),
    'https://[2001:db8::1]',
  );
  // Mixed-case hextets fold to lowercase — the arbAcceptedOrigin property only
  // generates fc.domain() hosts, so no IPv6 literal (let alone a mixed-case one)
  // ever exercises this case-fold; pin it directly the way the IDN case is.
  t.is(
    normalizeHttpClientOrigin('https://[2001:DB8::1]'),
    'https://[2001:db8::1]',
  );
  t.is(
    normalizeHttpClientOrigin('https://[2001:DB8::AB]:443'),
    'https://[2001:db8::ab]',
  );
});

test('normalizeHttpClientOrigin canonicalizes a trailing-dot (fully qualified) host', t => {
  // A trailing-dot FQDN (`example.com.`) is a distinct DNS name that the WHATWG
  // URL parser preserves verbatim in the origin; it does not fold to the
  // dotless form, so an allowlist entry typed one way does not confine the
  // other. Pin that the canonical serialization keeps the trailing dot rather
  // than silently equating the two names.
  t.is(
    normalizeHttpClientOrigin('https://example.com./'),
    'https://example.com.',
  );
  t.not(
    normalizeHttpClientOrigin('https://example.com.'),
    normalizeHttpClientOrigin('https://example.com'),
  );
});

test('normalizeHttpClientOrigin handles the port boundaries', t => {
  // Port 0 is a distinct, valid port the WHATWG parser preserves (it is not the
  // https default, so it is not stripped); the top of the range is retained;
  // one past the range is not a valid URL and is refused by flag name.
  t.is(
    normalizeHttpClientOrigin('https://example.com:0'),
    'https://example.com:0',
  );
  t.is(
    normalizeHttpClientOrigin('https://example.com:65535'),
    'https://example.com:65535',
  );
  t.throws(() => normalizeHttpClientOrigin('https://example.com:65536'), {
    message: /not a valid http\(s\) origin/,
  });
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

test('makeHttpClientPolicy preserves case-collided origins verbatim (no local dedup)', t => {
  // Two `--origin` values that differ only in host case (and a stripped default
  // port) canonicalize to the same origin. The assembler does NOT dedup them —
  // it hands the daemon exactly as many entries as the operator typed. Pin this:
  // the duplication is harmless (the daemon's allowlist membership check is
  // idempotent, so a repeated origin neither widens nor narrows confinement),
  // and folding duplicates silently here would hide a typo the operator may want
  // surfaced. If a later phase adds dedup, it should be a deliberate, tested
  // change rather than an accident, so this locks in the current contract.
  const policy = makeHttpClientPolicy({
    allowedOrigins: [
      'https://Example.com',
      'https://example.com',
      'https://EXAMPLE.com:443',
    ],
  });
  t.deepEqual(policy, {
    allowedOrigins: [
      'https://example.com',
      'https://example.com',
      'https://example.com',
    ],
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

test('normalizeHttpClientOrigin agrees with the daemon origin oracle over accepted origins', async t => {
  await fc.assert(
    fc.property(arbAcceptedOrigin, raw => {
      const once = normalizeHttpClientOrigin(raw);
      // A second pass over the already-canonical form is a fixed point.
      t.is(normalizeHttpClientOrigin(once), once);
      // The load-bearing claim is stronger than self-idempotence: the output
      // must be a fixed point of `new URL(o).origin` — the exact predicate the
      // daemon's `assertHttpClientOrigin` applies (`new URL(o).origin === o`).
      // Self-idempotence alone would hold for any deterministic function; this
      // oracle pins agreement with the daemon.
      t.is(new URL(once).origin, once);
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
  t.is(parse('9007199254740991'), Number.MAX_SAFE_INTEGER);
  // Exactly MAX_SAFE_INTEGER + 1 (2^53) is representable as a double yet is not
  // a *safe* integer, so it must reject at the isSafeInteger guard — the tight
  // boundary one past the last admissible value, distinct from the +2 case
  // below (which Number() silently rounds).
  t.throws(() => parse('9007199254740992'), {
    message: /must be a safe integer/,
  });
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

test('parsePositiveIntegerFlag round-trips every positive safe integer', async t => {
  const parse = parsePositiveIntegerFlag('--max-response-bytes');
  await fc.assert(
    fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), n => {
      // The decimal spelling of any positive safe integer parses back to it,
      // and re-spelling the result is a fixed point — the hand-picked examples
      // above check three points; this pins the whole admissible range.
      t.is(parse(String(n)), n);
      t.is(parse(String(parse(String(n)))), n);
    }),
  );
});

test('collectHttpOrigin folds an arbitrary sequence into flag order', async t => {
  await fc.assert(
    fc.property(fc.array(fc.string()), values => {
      // Commander calls the coercer once per repeated flag, threading the prior
      // accumulator; folding it over any sequence must reproduce that sequence
      // exactly (a last-wins regression would collapse it to the final value).
      const collected = values.reduce(
        (previous, value) => collectHttpOrigin(value, previous),
        undefined,
      );
      if (values.length === 0) {
        t.is(collected, undefined);
      } else {
        t.deepEqual(collected, values);
      }
    }),
  );
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
      // origin's shape and never dials it, so no listening server is needed. The
      // second origin is fed in a NON-canonical form (uppercase host, explicit
      // default port, trailing slash) so the stderr echo assertion below pins
      // canonicalization, not merely echoing back what was typed.
      const result = await endo(
        'http',
        'mk',
        'my-http',
        '--origin',
        'http://127.0.0.1:8080',
        '--origin',
        'https://API.example.com:443/',
      );
      const lines = result.stdout.split('\n').filter(Boolean);
      t.deepEqual(
        lines,
        ['my-http'],
        'mk should print the pet name it registered',
      );

      // The effective-bound echo on stderr is an advertised legibility
      // affordance (Phase 1 has no inspect verb); deleting the process.stderr
      // block must redden a test. Pin both the minted-policy echo and that it
      // carries the CANONICAL origin (lowercased host, default port stripped,
      // slash dropped), not the non-canonical form typed above.
      t.regex(result.stderr, /minted strict HTTP client "my-http" over/);
      t.regex(result.stderr, /https:\/\/api\.example\.com(?![:/])/);
      t.notRegex(result.stderr, /API\.example\.com/);

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

test.serial(
  'endo http mk rebind leaves an old client that another name still holds',
  async t => {
    // The survives-when-granted branch of the rebind claim
    // (designs/cli-http-client.md: the previous client is collected UNLESS
    // another edge still holds it). `copy` gives the first-minted client a
    // second name (the CLI-observable stand-in for "granted to a guest under
    // another name"); after `feed` is rebound to a fresh client, the copied
    // name must still denote the original — the rebind drops only `feed`'s
    // reference, not the surviving edge. (The collected-when-unreferenced
    // branch is daemon-internal — storeIdentifier -> removeEdgeIfUnreferenced —
    // and Phase 1 exposes no CLI verb to observe an orphan formula, so it is
    // covered by the daemon's own store tests, not from the CLI.)
    await endo('purge', '-f');
    await endo('start');
    try {
      await endo('http', 'mk', 'feed', '--origin', 'https://a.example');
      // A second edge to the first-minted client.
      await endo('copy', 'feed', 'pinned');
      // Rebind `feed` to a brand-new client under a different policy.
      await endo('http', 'mk', 'feed', '--origin', 'https://b.example');

      const list = await endo('list');
      const names = list.stdout.split('\n').filter(Boolean);
      t.true(
        names.some(line => /\bfeed\b/.test(line)),
        'the rebound name should still resolve',
      );
      t.true(
        names.some(line => /\bpinned\b/.test(line)),
        'the copied name should survive the rebind of the other edge',
      );
    } finally {
      await endo('purge', '-f');
    }
  },
);

test.serial(
  'endo http mk tofu-auto echoes the unbounded-grant warning on a real mint',
  async t => {
    // The tofu-auto warning is an advertised legibility affordance for a grant
    // that voids the allowlist bound; deleting the second process.stderr block
    // must redden a test. The local `refuses tofu-auto without
    // --acknowledge-unbounded` test only exercises the REFUSAL — the accepted,
    // acknowledged mint's warning path was pinned nowhere.
    await endo('purge', '-f');
    await endo('start');
    try {
      const result = await endo(
        'http',
        'mk',
        'wild',
        '--origin',
        'https://seed.example',
        '--policy-mode',
        'tofu-auto',
        '--acknowledge-unbounded',
      );
      t.deepEqual(
        result.stdout.split('\n').filter(Boolean),
        ['wild'],
        'the acknowledged tofu-auto mint should register the name',
      );
      t.regex(result.stderr, /minted tofu-auto HTTP client "wild" over/);
      t.regex(result.stderr, /warning:.*tofu-auto/);
      t.regex(result.stderr, /does not bound outbound reach/);
    } finally {
      await endo('purge', '-f');
    }
  },
);

test.serial(
  'endo http mk is host-only: a guest cannot mint a client',
  async t => {
    // The confinement claim "provideHttpClient is a host-only method, so a guest
    // name fails at the interface guard" is stated in http-mk.js, the changeset,
    // and the design doc, yet pinned by no test. Minting `--as` a guest must be
    // refused, and the name must not appear afterward.
    await endo('purge', '-f');
    await endo('start');
    try {
      await endo('mkguest', 'g');
      await t.throwsAsync(
        endo(
          'http',
          'mk',
          'sneaky',
          '--origin',
          'https://a.example',
          '--as',
          'g',
        ),
        undefined,
        'a guest must not be able to mint an HTTP client',
      );
      const list = await endo('list');
      t.notRegex(
        list.stdout,
        /\bsneaky\b/,
        'the rejected mint must leave no registered name',
      );
    } finally {
      await endo('purge', '-f');
    }
  },
);
