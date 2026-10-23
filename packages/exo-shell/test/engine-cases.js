// @ts-check

/**
 * Timeout and output-cap cases every Shell engine must agree on.  The host
 * engine runs them in `shell.test.js`; the sandbox engine runs the same table
 * in `@endo/sandbox`'s `shell-engine.test.js`.  Each case uses only coreutils,
 * which both a host and a `host-bind` sandbox slice can reach.
 *
 * @import { ShellResult } from '../src/types.js'
 */

/**
 * @typedef {object} EngineCase
 * @property {string} name
 * @property {string} command
 * @property {string[]} commandArguments
 * @property {{ timeoutMs?: number, maxOutputBytes?: number }} policy
 * @property {(result: ShellResult) => Record<string, unknown>} [observe]
 *   Project the result onto the fields that must match across engines.
 * @property {Record<string, unknown>} [expected]
 * @property {string} [expectedError]
 */

/** @type {readonly EngineCase[]} */
export const engineCases = harden([
  {
    name: 'output within the cap is returned whole',
    command: 'echo',
    commandArguments: ['ok'],
    policy: {},
    observe: ({ stdout, exitCode, truncated }) => ({
      stdout,
      exitCode,
      truncated,
    }),
    expected: { stdout: 'ok\n', exitCode: 0, truncated: false },
  },
  {
    name: 'stdout past the cap is cut at the cap and flagged',
    command: 'seq',
    commandArguments: ['1', '1000'],
    policy: { maxOutputBytes: 10 },
    observe: ({ stdout, truncated }) => ({ stdout, truncated }),
    expected: { stdout: '1\n2\n3\n4\n5\n', truncated: true },
  },
  {
    name: 'a non-zero exit is returned as data',
    command: 'ls',
    commandArguments: ['/no-such-path-for-engine-cases'],
    policy: {},
    observe: ({ exitCode, stdout, truncated }) => ({
      failed: exitCode !== 0 && exitCode !== null,
      stdout,
      truncated,
    }),
    expected: { failed: true, stdout: '', truncated: false },
  },
  {
    name: 'a process outliving the timeout is killed and rejects',
    command: 'sleep',
    commandArguments: ['30'],
    policy: { timeoutMs: 300 },
    expectedError: 'Shell command timed out after 300ms',
  },
]);
