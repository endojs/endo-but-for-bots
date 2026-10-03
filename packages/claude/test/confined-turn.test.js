// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { runConfinedTurn } from '../src/confined-turn.js';
import { ALLOWED_ENV_KEYS } from '../src/child-env.js';
import { resultFromStream } from '../src/launch.js';
import {
  assembleBwrapArgv,
  resolveSystemMounts,
  DEFAULT_SCRATCH_HOME,
} from '../src/bwrap-slice.js';

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
    sandbox: false,
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

test('omitting the sandbox refuses to run instead of dropping the slice', async t => {
  await t.throwsAsync(turn({ sandbox: undefined }), {
    message: /sandbox must be/,
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

/**
 * A listening unix socket standing in for the daemon's, outside every
 * directory the slice grants.
 */
const listenLikeDaemon = async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'endo-claude-turn-daemon-'),
  );
  const socketPath = path.join(directory, 'endo.sock');
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(socketPath, () => resolve(null)));
  const close = async () => {
    await new Promise(resolve => server.close(() => resolve(null)));
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, socketPath, close };
};

/** @param {string[]} probe */
const probePrompt = probe =>
  JSON.stringify({ tool: 'list', arguments: {}, probe });

/**
 * Re-run a recorded `bwrap` argv's command directly, so the sandbox wiring is
 * observable on a host without `bwrap`.
 *
 * @param {unknown[][]} recorded
 */
const makeRecordingSpawn = recorded =>
  /** @type {any} */ (
    (
      /** @type {string} */ command,
      /** @type {string[]} */ bwrapArguments,
      /** @type {any} */ options,
    ) => {
      recorded.push([command, bwrapArguments]);
      const separator = bwrapArguments.indexOf('--');
      return childProcess.spawn(
        bwrapArguments[separator + 1],
        bwrapArguments.slice(separator + 2),
        options,
      );
    }
  );

test('the daemon-socket probe detects a reachable socket without the slice', async t => {
  const daemonSocket = await listenLikeDaemon();
  try {
    const { result } = await turn({
      prompt: probePrompt([daemonSocket.socketPath]),
    });
    t.is(result.type, 'ok', JSON.stringify(result));
    const report = JSON.parse(/** @type {any} */ (result).text);
    t.deepEqual(report.probes[daemonSocket.socketPath], {
      exists: true,
      connect: 'connected',
    });
  } finally {
    await daemonSocket.close();
  }
});

test('the sandbox wraps claude in bwrap, granting the broker and spawn directories', async t => {
  /** @type {unknown[][]} */
  const recorded = [];
  const { result } = await turn({
    spawn: makeRecordingSpawn(recorded),
    sandbox: { bwrapPath: '/usr/bin/bwrap' },
  });
  t.is(result.type, 'ok', JSON.stringify(result));
  const report = JSON.parse(/** @type {any} */ (result).text);

  t.is(recorded.length, 1);
  const [[command, bwrapArguments]] = /** @type {[string, string[]][]} */ (
    recorded
  );
  t.is(command, '/usr/bin/bwrap');
  const separator = bwrapArguments.indexOf('--');
  t.is(bwrapArguments[separator + 1], fs.realpathSync(FAKE_CLAUDE));

  /** @param {string} flag */
  const sourcesOf = flag =>
    bwrapArguments
      .slice(0, separator)
      .flatMap((value, index) =>
        value === flag ? [bwrapArguments[index + 1]] : [],
      );
  const readOnly = sourcesOf('--ro-bind');
  const writable = sourcesOf('--bind');

  const settingsPath = report.argv[report.argv.indexOf('--settings') + 1];
  const spawnDirectory = path.dirname(settingsPath);
  const { mcpServers } = JSON.parse(report.mcpConfigText);
  // The one server entry's only array value is the relay's argument list.
  const relayArguments = /** @type {string[]} */ (
    Object.values(Object.values(mcpServers)[0]).find(Array.isArray)
  );
  const brokerSocket = relayArguments[relayArguments.length - 1];
  t.true(readOnly.includes(spawnDirectory), 'spawn directory granted');
  t.true(readOnly.includes(path.dirname(brokerSocket)), 'broker granted');
  t.true(readOnly.includes(relayArguments[2]), 'relay script granted');
  // `report.cwd` is the canonical path (`/private/tmp/...` on macOS).
  t.is(writable.length, 1, 'only the work directory is writable');
  t.true(report.cwd.endsWith(writable[0]));

  // No grant covers the whole turn directory, which holds every spawn's files.
  const turnDirectory = path.dirname(writable[0]);
  t.is(path.dirname(spawnDirectory), turnDirectory);
  t.false([...readOnly, ...writable].includes(turnDirectory));
});

test('the sandbox runs a symlinked claudePath by its real path', async t => {
  const linkDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'endo-claude-turn-link-'),
  );
  t.teardown(() => fs.rmSync(linkDirectory, { recursive: true, force: true }));
  const claudeLink = path.join(linkDirectory, 'claude');
  fs.symlinkSync(FAKE_CLAUDE, claudeLink);
  /** @type {unknown[][]} */
  const recorded = [];
  const { result } = await turn({
    claudePath: claudeLink,
    spawn: makeRecordingSpawn(recorded),
    sandbox: { bwrapPath: '/usr/bin/bwrap' },
  });
  t.is(result.type, 'ok', JSON.stringify(result));
  const [[, bwrapArguments]] = /** @type {[string, string[]][]} */ (recorded);
  const separator = bwrapArguments.indexOf('--');
  const realClaude = fs.realpathSync(FAKE_CLAUDE);
  t.is(bwrapArguments[separator + 1], realClaude);
  const granted = bwrapArguments.slice(0, separator);
  t.true(granted.includes(realClaude));
  t.false(
    granted.includes(path.dirname(realClaude)),
    'the directory around a lone binary is not granted',
  );
  t.false(granted.includes(claudeLink), 'the link itself is not bound');
});

test('the sandbox grants a package-installed claude its package directory', async t => {
  const packageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'endo-claude-turn-package-'),
  );
  t.teardown(() =>
    fs.rmSync(packageDirectory, { recursive: true, force: true }),
  );
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), '{}');
  const claudeScript = path.join(packageDirectory, 'cli.mjs');
  fs.copyFileSync(FAKE_CLAUDE, claudeScript);
  fs.chmodSync(claudeScript, 0o755);
  /** @type {unknown[][]} */
  const recorded = [];
  const { result } = await turn({
    claudePath: claudeScript,
    spawn: makeRecordingSpawn(recorded),
    sandbox: { bwrapPath: '/usr/bin/bwrap' },
  });
  t.is(result.type, 'ok', JSON.stringify(result));
  const [[, bwrapArguments]] = /** @type {[string, string[]][]} */ (recorded);
  const separator = bwrapArguments.indexOf('--');
  const granted = bwrapArguments.slice(0, separator);
  t.true(granted.includes(fs.realpathSync(packageDirectory)));
});

/** Find a `bwrap` that can create the slice's namespaces on this host. */
const findWorkingBwrap = async () => {
  const candidates = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    '/usr/bin',
    '/bin',
  ].map(directory => path.join(directory, 'bwrap'));
  const bwrapPath = candidates.find(candidate => fs.existsSync(candidate));
  if (bwrapPath === undefined) return { reason: 'bwrap is not installed' };
  const systemMounts = await resolveSystemMounts();
  const probe = childProcess.spawnSync(
    bwrapPath,
    assembleBwrapArgv({
      systemMounts,
      readOnlyPaths: [],
      writablePaths: [],
      cwd: '/',
      command: '/bin/sh',
      commandArguments: ['-c', 'true'],
    }),
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (probe.status !== 0) {
    return {
      reason: `bwrap cannot create the slice here: ${probe.stderr || probe.error?.message || probe.status}`,
    };
  }
  return { bwrapPath };
};

test('inside the bwrap slice the daemon socket has no path', async t => {
  const { bwrapPath, reason } = await findWorkingBwrap();
  if (bwrapPath === undefined) {
    if (process.env.ENDO_CLAUDE_REQUIRE_BWRAP === '1') {
      t.fail(`ENDO_CLAUDE_REQUIRE_BWRAP=1 but ${reason}`);
    } else {
      t.log(`skipped: ${reason}`);
      t.pass();
    }
    return;
  }
  const daemonSocket = await listenLikeDaemon();
  try {
    const { daemon, result } = await turn({
      prompt: probePrompt([daemonSocket.socketPath, daemonSocket.directory]),
      sandbox: { bwrapPath },
    });
    t.is(result.type, 'ok', JSON.stringify(result));
    const report = JSON.parse(/** @type {any} */ (result).text);

    // The broker is reachable: the one guest's tool ran.
    t.true(JSON.stringify(report.call.result).includes('mine-name'));
    t.deepEqual(daemon.calls, [
      ['host', 'lookupById', FORMULA_ID],
      ['mine', 'list'],
    ]);

    // The daemon socket and its directory do not exist inside the slice.
    t.deepEqual(report.probes[daemonSocket.socketPath], {
      exists: false,
      connect: 'ENOENT',
    });
    t.false(report.probes[daemonSocket.directory].exists);

    // A writable scratch HOME; read-only spawn files.
    t.is(report.home, DEFAULT_SCRATCH_HOME);
    t.is(report.homeWrite, 'written');
    t.is(report.spawnDirectoryWrite, 'EROFS');
  } finally {
    await daemonSocket.close();
  }
});
