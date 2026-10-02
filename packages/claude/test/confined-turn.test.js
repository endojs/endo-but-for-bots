// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { runConfinedTurn } from '../src/confined-turn.js';
import { ALLOWED_ENV_KEYS } from '../src/child-env.js';
import { resultFromStream } from '../src/launch.js';

const FAKE_CLAUDE = fileURLToPath(
  new URL('fixtures/fake-claude.mjs', import.meta.url),
);
const FORMULA_ID = 'ab'.repeat(32);
const OTHER_ID = 'cd'.repeat(32);
const NODE = '12'.repeat(32);
const CREDENTIAL = 'sk-ant-api03-confined-turn-test-credential';
const MODEL = 'claude-sonnet-4-5';

// The harness process's own ambient authority. None of it may reach the
// confined side: the constructed child env starts empty.
const DAEMON_SOCK = '/run/user/4242/endo/captp0.sock';
process.env.ENDO_SOCK = DAEMON_SOCK;
process.env.XDG_RUNTIME_DIR = '/run/user/4242';
process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-harness-key';

/**
 * @param {string} name
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const makeFake = (name, methods) =>
  makeExo(
    name,
    M.interface(name, {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );

/**
 * @param {string} label
 * @param {unknown[][]} calls
 */
const makeFakeGuest = (label, calls) =>
  makeFake('EndoGuest', {
    help: () => `help for ${label}`,
    has: () => false,
    list: () => {
      calls.push([label, 'list']);
      return [`${label}-name`];
    },
    remove: () => {},
    move: () => {},
    copy: () => {},
    makeDirectory: () => {},
    readText: () => '',
    writeText: () => {},
    listMessages: () => [],
    send: () => {},
    reply: () => {},
    adopt: () => {},
    dismiss: () => {},
    request: () => new Promise(() => {}),
    define: () => {},
  });

const makeFakeDaemon = () => {
  /** @type {unknown[][]} */
  const calls = [];
  let closes = 0;
  const closed = makePromiseKit();
  const guests = {
    [FORMULA_ID]: makeFakeGuest('mine', calls),
    [OTHER_ID]: makeFakeGuest('other', calls),
  };
  const host = makeFake('EndoHost', {
    identify: name =>
      name === '@agent' ? `${'00'.repeat(32)}:${NODE}` : undefined,
    lookupById: qualified => {
      const [id] = qualified.split(':');
      calls.push(['host', 'lookupById', id]);
      if (!Object.hasOwn(guests, id)) throw Error('Unknown formula');
      return guests[id];
    },
  });
  const connect = async () =>
    harden({
      host,
      closed: closed.promise,
      close: () => {
        closes += 1;
      },
    });
  return {
    calls,
    connect,
    get closes() {
      return closes;
    },
  };
};

/**
 * @param {object} [overrides]
 */
const turn = async (overrides = {}) => {
  const daemon = makeFakeDaemon();
  const parentDir = fs.mkdtempSync('/tmp/ect-');
  const result = await runConfinedTurn({
    formulaId: FORMULA_ID,
    credential: CREDENTIAL,
    prompt: JSON.stringify({ tool: 'list', arguments: {} }),
    model: MODEL,
    claudePath: FAKE_CLAUDE,
    connect: daemon.connect,
    parentDir,
    onStderr: chunk => process.stderr.write(chunk),
    ...overrides,
  });
  const leftovers = fs.readdirSync(parentDir);
  fs.rmSync(parentDir, { recursive: true, force: true });
  return { daemon, result, leftovers };
};

test('a confined turn reaches exactly one guest through the harness-owned broker', async t => {
  const { daemon, result, leftovers } = await turn();
  t.is(result.type, 'ok', JSON.stringify(result));
  const report = JSON.parse(/** @type {any} */ (result).text);

  t.is(report.serverInfo.name, 'endo');
  t.true(report.tools.includes('list'));
  // The broker's own tools/list, as the confined side reads it, carries no
  // withheld name: pruning is at the broker, not only in --allowedTools.
  for (const name of [
    'evaluate',
    'define',
    'storeIdentifier',
    'storeLocator',
  ]) {
    t.false(report.tools.includes(name), `${name} is absent at the broker`);
  }
  t.falsy(report.call.result.isError);
  t.true(JSON.stringify(report.call.result).includes('mine-name'));
  t.deepEqual(
    daemon.calls,
    [
      ['host', 'lookupById', FORMULA_ID],
      ['mine', 'list'],
    ],
    'the harness resolved one guest once, and only that guest was called',
  );

  // Teardown on the success path: daemon session closed, every file removed.
  t.is(daemon.closes, 1);
  t.deepEqual(leftovers, []);
});

test('the confined process has no daemon socket and no credential in its MCP child env', async t => {
  const { result } = await turn();
  t.is(result.type, 'ok', JSON.stringify(result));
  const report = JSON.parse(/** @type {any} */ (result).text);

  // The confined `claude`: a constructed environment, no daemon socket. macOS
  // adds `__CF_USER_TEXT_ENCODING` to every process at exec; the harness does
  // not supply it.
  const osInjected = ['__CF_USER_TEXT_ENCODING'];
  for (const name of report.ownEnvNames) {
    t.true(
      ALLOWED_ENV_KEYS.includes(name) || osInjected.includes(name),
      `claude env carries ${name}`,
    );
  }
  t.false(report.ownEnvNames.includes('ENDO_SOCK'));
  t.false(report.ownEnvNames.includes('XDG_RUNTIME_DIR'));
  t.false(report.ownEnvNames.includes('HOME'));
  t.false(report.ownEnvNames.includes('ANTHROPIC_API_KEY'));

  // Nothing handed to it names the daemon socket or the guest.
  const handed = JSON.stringify([report.argv, report.mcpConfigText]);
  t.false(handed.includes(DAEMON_SOCK));
  t.false(handed.includes('/run/user/4242'));
  t.false(handed.includes(FORMULA_ID), 'the formula id stays in the harness');
  t.false(handed.includes(CREDENTIAL), 'the credential is not in argv/config');

  if (process.platform !== 'linux') {
    t.log('not Linux: descriptor and environ checks skipped');
    return;
  }
  // No descriptor is inherited into the confined tree beyond its stdio.
  const inherited = report.startupFds
    .filter(
      ([fd, target]) => Number(fd) > 2 && String(target).startsWith('socket:'),
    )
    .map(([fd]) => fd);
  t.deepEqual(inherited, [], 'no inherited socket descriptor');

  // The MCP child (the relay): its environment, read by the kernel, is empty,
  // even though `claude` held the credential in ANTHROPIC_AUTH_TOKEN and
  // merged its whole environment into the spawn.
  t.deepEqual(report.mcpChildEnviron, []);
  t.false(report.mcpChildHasCredential);
});

test('a formula that is not a guest fails closed before any spawn', async t => {
  await t.throwsAsync(turn({ formulaId: 'ef'.repeat(32) }), {
    message: /does not resolve to a guest/,
  });
  await t.throwsAsync(turn({ formulaId: 'not-a-formula-id' }), {
    message: /64/,
  });
});

test('an unpinned claude version refuses to spawn', async t => {
  await t.throwsAsync(turn({ pinnedCliVersion: '9.9.9' }), {
    message: /pinned/,
  });
});

test('resultFromStream maps terminal outcomes', t => {
  t.deepEqual(
    resultFromStream(
      {
        outcome: { type: 'error' },
        fields: { subtype: 'error_max_turns' },
      },
      1,
    ),
    { type: 'limit-exceeded', which: 'max-turns' },
  );
  t.deepEqual(
    resultFromStream({ outcome: { type: 'parse-error', detail: 'x' } }, 0),
    { type: 'parse-error', detail: 'x' },
  );
  t.deepEqual(
    resultFromStream({ outcome: { type: 'parse-error', detail: 'x' } }, 137),
    { type: 'nonzero-exit', code: 137 },
  );
  t.deepEqual(
    resultFromStream(
      { outcome: { type: 'rate-limited' }, quota: { resetsAt: 20 } },
      1,
      () => 10_000,
    ),
    { type: 'rate-limited', retryAfterMs: 10_000 },
  );
  t.deepEqual(
    resultFromStream({ outcome: { type: 'api-error', status: 500 } }, 0),
    { type: 'nonzero-exit', code: 1 },
  );
});
