// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { stderr } from 'node:process';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

// This cross-package integration test deliberately exercises the public
// Agentry thunk from the daemon's lifecycle suite. @endo/agentry is
// intentionally NOT added to this package's package.json: @endo/agentry
// already depends on @endo/daemon in production, and a devDependency in the
// other direction closes a cycle that turbo's build graph rejects outright
// (`@endo/daemon#build -> @endo/agentry#build -> @endo/daemon#build`). The
// relative import stays undeclared on purpose; keep it dev/test-only.
/* eslint-disable import/no-relative-packages */
import { reconstructEndoCodeMode } from '../../agentry/code-mode-provisioning.js';
import { makeEndoCodeModePiExtension } from '../../agentry/endo-code-mode-pi-extension.js';
/* eslint-enable import/no-relative-packages */

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';

const execFileAsync = promisify(execFile);

/**
 * Minimal Pi lifecycle driver for the real-daemon extension demo.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.sessionId
 * @param {unknown[]} options.entries
 * @param {string} [options.flag]
 * @param {string} options.sockPath
 */
const makePiExtensionDriver = ({ cwd, sessionId, entries, flag, sockPath }) => {
  /** @type {Map<string, Array<(event: unknown, context: unknown) => unknown>>} */
  const handlers = new Map();
  /** @type {unknown[]} */
  const tools = [];
  /** @type {Array<{ customType: string, data: unknown }>} */
  const appended = [];
  /** @type {string[][]} */
  const activeTools = [];
  const api =
    /** @type {Parameters<ReturnType<typeof makeEndoCodeModePiExtension>>[0]} */ (
      /** @type {unknown} */ ({
        on: (name, handler) => {
          const current = handlers.get(name) ?? [];
          current.push(handler);
          handlers.set(name, current);
        },
        registerFlag: () => {},
        getFlag: name => (name === 'endo-provision' ? flag : undefined),
        registerCommand: () => {},
        registerTool: tool => tools.push(tool),
        getActiveTools: () => [],
        setActiveTools: names => activeTools.push([...names]),
        appendEntry: (customType, data) => appended.push({ customType, data }),
      })
    );
  const extension = makeEndoCodeModePiExtension({
    reconstructProvision: (persistence, { onConnectionFailure }) =>
      reconstructEndoCodeMode({
        persistence,
        sockPath,
        onConnectionFailure,
      }),
    startDaemon: async () => {
      throw Error('custom test daemon should already be running');
    },
    terminate: status => {
      throw Error(`unexpected Pi termination ${status}`);
    },
  });
  extension(api);
  const context = {
    cwd,
    mode: 'tui',
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: {
      notify: message => {
        throw Error(`unexpected Pi notification: ${message}`);
      },
    },
  };

  /**
   * @param {'session_start' | 'session_shutdown'} name
   * @param {unknown} event
   */
  const emit = async (name, event) => {
    await null;
    for (const handler of handlers.get(name) ?? []) {
      // Lifecycle hooks are sequential in Pi and in this driver.
      // eslint-disable-next-line no-await-in-loop
      await handler(event, context);
    }
  };
  return { activeTools, appended, emit, tools };
};

test.serial(
  'Pi extension evaluates through a retained daemon guest in a disposable repository',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);

    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    await execFileAsync('git', ['add', 'README.md'], {
      cwd: fixture.workspace,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Pi Extension Test',
        '-c',
        'user.email=pi-extension@example.test',
        'commit',
        '-q',
        '-m',
        'initial',
      ],
      { cwd: fixture.workspace },
    );

    const driver = makePiExtensionDriver({
      cwd: fixture.workspace,
      sessionId: 'pi-extension-demo',
      entries: [],
      flag: JSON.stringify({ fs: 'readWrite', git: 'readOnly' }),
      sockPath: fixture.sockPath,
    });
    await driver.emit('session_start', {
      type: 'session_start',
      reason: 'startup',
    });

    t.deepEqual(driver.activeTools, [[], ['evaluate']]);
    t.is(driver.tools.length, 1);
    const evaluate =
      /** @type {{ execute: (id: string, params: Record<string, unknown>, signal: undefined, update: undefined) => Promise<{ content: Array<{ type: string, text: string }>, details: unknown }> }} */ (
        driver.tools[0]
      );
    const readResult = await evaluate.execute(
      'read',
      { source: 'E(workspace).readText("README.md")' },
      undefined,
      undefined,
    );
    t.deepEqual(readResult.content, [{ type: 'text', text: 'initial\n' }]);

    await evaluate.execute(
      'write',
      {
        source: 'E(workspace).writeText("created-by-pi.txt", "retained\\n")',
      },
      undefined,
      undefined,
    );
    t.is(
      (
        await execFileAsync('git', ['status', '--short'], {
          cwd: fixture.workspace,
        })
      ).stdout,
      '?? created-by-pi.txt\n',
    );
    /** @type {string[]} */
    const rawDiagnostics = [];
    const originalStderrWrite = stderr.write;
    stderr.write = /** @type {typeof stderr.write} */ (
      chunk => {
        rawDiagnostics.push(String(chunk));
        return true;
      }
    );
    try {
      await t.throwsAsync(
        evaluate.execute(
          'invalid-list-path',
          {
            source:
              '(async () => { const wt = await E(git).worktree(); return E(wt).list([]); })()',
          },
          undefined,
          undefined,
        ),
        { message: /Must be a string/ },
      );
    } finally {
      stderr.write = originalStderrWrite;
    }
    t.deepEqual(
      rawDiagnostics,
      [],
      'the awaited tool rejection is not also presented by CapTP',
    );
    await t.throwsAsync(
      evaluate.execute(
        'blocked-commit',
        { source: 'E(git).commit("must not commit")' },
        undefined,
        undefined,
      ),
      { message: /no method "commit"/ },
    );
    await evaluate.execute(
      'retain-value',
      { source: '40 + 2', resultName: ['answer'] },
      undefined,
      undefined,
    );

    t.is(driver.appended.length, 1);
    const persistence =
      /** @type {import('../../agentry/src/code-mode-provisioning-types.js').EndoProvisionPersistence} */ (
        driver.appended[0].data
      );
    t.deepEqual(persistence.guestHandlePath.slice(0, 2), ['code-mode', 'pi']);
    await driver.emit('session_shutdown', {
      type: 'session_shutdown',
      reason: 'quit',
    });

    const host = await fixture.connectHost('pi-extension-inspector');
    const guestAgentPath = [
      ...persistence.guestHandlePath.slice(0, -1),
      'guest-agent',
    ];
    t.true(await E(host).has(...persistence.guestHandlePath));
    const retainedGuest = await E(host).lookup(guestAgentPath);
    t.is(await E(retainedGuest).lookup('answer'), 42);

    const resumeEntry = {
      type: 'custom',
      customType: 'endo.pi-code-mode.provision',
      data: persistence,
    };
    const resumed = makePiExtensionDriver({
      cwd: fixture.workspace,
      sessionId: 'pi-extension-demo',
      entries: [resumeEntry],
      sockPath: fixture.sockPath,
    });
    await resumed.emit('session_start', {
      type: 'session_start',
      reason: 'resume',
    });
    const resumedEvaluate = /** @type {typeof evaluate} */ (resumed.tools[0]);
    const resumedRead = await resumedEvaluate.execute(
      'resumed-read',
      { source: 'E(workspace).readText("created-by-pi.txt")' },
      undefined,
      undefined,
    );
    t.is(resumedRead.content[0].text, 'retained\n');
    t.deepEqual(resumed.appended[0].data, persistence);
    await resumed.emit('session_shutdown', {
      type: 'session_shutdown',
      reason: 'quit',
    });

    t.true(
      await E(host).has(...persistence.guestHandlePath),
      'connection shutdown leaves the retained guest formula intact',
    );
  },
);
