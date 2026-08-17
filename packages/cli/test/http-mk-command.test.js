// @ts-nocheck

import os from 'os';
import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

import {
  makeHttpClientPolicy,
  normalizeHttpClientOrigin,
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

test('makeHttpClientPolicy normalizes browser-copied origin forms', t => {
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
