// @ts-check
/// <reference types="ses"/>
// spell-out-exempt: interoperates with the existing argGuards tool protocol.

/** @import { ERef } from '@endo/eventual-send' */
/** @import { InterfaceGuard, Pattern } from '@endo/patterns' */
/** @import { ShellToolCapability, ToolRecord, RejectPatternEntry, RejectFlagEntry, ShellToolOptions } from '../types.js' */

/** @typedef {Record<keyof ShellToolCapability, (...argumentVector: unknown[]) => Promise<unknown>>} ShellToolDispatch */

import { E } from '@endo/eventual-send';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import {
  ShellInterface,
  formatShellCommandUsage,
  matchShellCommand,
  normalizeShellCommandGrammars,
} from '@endo/exo-shell';

import { makeTool } from '../tool.js';

/**
 * Build an advisory command-string veto from `@endo/exo-shell`-style reject
 * entries.  Ported from the prior agent framework's command-tool policy
 * (`rejectPatterns` / `rejectFlags`).  These run in the tool layer,
 * *before* the call reaches `Shell.exec`, and are hardening advice — not the
 * boundary.  The boundary is the formula-owned command grammars enforced
 * inside the `Shell` exo (design § Command grammars); a granted child is
 * still an ordinary host process, so the veto is defense-in-depth, not
 * confinement.
 *
 * @param {RejectPatternEntry[]} rejectPatterns
 * @param {RejectFlagEntry[]} rejectFlags
 * @returns {(command: string, argumentVector: string[]) => void}
 */
const makeAdvisoryVeto = (rejectPatterns, rejectFlags) => {
  /** @type {Map<string, string | undefined>} */
  const forbiddenFlags = new Map();
  for (const entry of rejectFlags) {
    if (typeof entry === 'string') {
      forbiddenFlags.set(entry, undefined);
    } else {
      forbiddenFlags.set(entry.flag, entry.reason);
    }
  }
  return harden((command, argumentVector) => {
    const tokens = harden([command, ...argumentVector]);
    for (const entry of rejectPatterns) {
      const pattern = entry instanceof RegExp ? entry : entry.pattern;
      const reason = entry instanceof RegExp ? undefined : entry.reason;
      if (tokens.some(token => pattern.test(token))) {
        throw new Error(
          reason
            ? `Command contains a forbidden pattern: ${reason}`
            : 'Command contains a forbidden pattern',
        );
      }
    }
    for (const token of tokens) {
      if (forbiddenFlags.has(token)) {
        const reason = forbiddenFlags.get(token);
        throw new Error(
          reason
            ? `Forbidden flag: ${token} — ${reason}`
            : `Forbidden flag: ${token}`,
        );
      }
    }
  });
};

/**
 * JSON Schemas for the Shell methods exposed as agent tools. Hand-authored and
 * pinned against `ShellInterface` by the divergence gate
 * (`test/shell-tool.test.js`).
 *
 * @type {Record<keyof ShellToolCapability, { description: string, parameters: object }>}
 */
const shellToolSchemas = harden({
  exec: {
    description:
      'Run a command with a structured argv (no shell string, no ' +
      'interpolation). The argv must match one of the granted command ' +
      'grammars; call inspect for their usage lines. Returns { stdout, ' +
      'stderr, exitCode, signal, truncated }; a non-zero exitCode is data, ' +
      'not an error.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The program to run (argv[0]); must be the program of a ' +
            'granted command grammar.',
        },
        argumentVector: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Arguments passed to the program, one array element each; ' +
            'the vector must match a granted command grammar.',
        },
        options: {
          // Open object (no `additionalProperties: false`) to match the
          // runtime guard `ExecOptionsShape` — an `M.splitRecord` whose
          // optional part admits unlisted keys.  The divergence gate pins the
          // two together.
          type: 'object',
          properties: {
            timeoutMs: {
              type: 'number',
              description:
                'Per-call timeout in ms; may only narrow the policy timeout.',
            },
          },
          description: 'Optional per-call execution options.',
        },
      },
      required: ['command', 'argumentVector'],
      additionalProperties: false,
    },
  },
  inspect: {
    description:
      'Report the shell bounds: the granted command grammars with their ' +
      'usage lines, the timeout, and the output cap. Reveals no host path.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
});

/** @type {(keyof ShellToolCapability)[]} */
const shellToolMethods = harden(
  /** @type {(keyof ShellToolCapability)[]} */ (Object.keys(shellToolSchemas)),
);

/**
 * Positional argument guards for a method, required first and then optional.
 *
 * @param {string} method
 * @returns {Pattern[]}
 */
const positionalArgGuards = method => {
  const { methodGuards } = getInterfaceGuardPayload(
    /** @type {InterfaceGuard} */ (ShellInterface),
  );
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  return harden([...argGuards, ...(optionalArgGuards || [])]);
};

/**
 * Build agent-tool records for a live `Shell` capability: `exec` and
 * `inspect` only — `attenuate` is granter-facing and deliberately not a tool.
 *
 * @param {ERef<ShellToolCapability>} shellCap
 * @param {ShellToolOptions} [options]
 *   `commands` is the granted command-grammar array (passable data the
 *   granter already holds); when present, each grammar's rendered usage line
 *   is embedded in the `exec` tool description — the agent reads the accepted
 *   command forms up front instead of probing for them — and a non-matching
 *   argv is rejected tool-side with those usage lines before the round trip
 *   to the capability (the capability's own grammar check remains the
 *   boundary).
 *   `rejectPatterns` / `rejectFlags` are advisory reject entries ported from
 *   the prior agent framework's command-tool policy closures.
 *   They veto a command string *before* it reaches `Shell.exec`; they are not
 *   the boundary (the formula-owned command grammars are). They default to
 *   empty (unlike that prior policy, which shipped a curated
 *   `DANGEROUS_PATTERNS` set); a caller wanting advisory vetoes must pass
 *   them.
 * @returns {ToolRecord[]}
 */
export const makeShellTool = (shellCap, options = {}) => {
  const { rejectPatterns = [], rejectFlags = [], commands } = options;
  const veto = makeAdvisoryVeto(
    harden([...rejectPatterns]),
    harden([...rejectFlags]),
  );
  const grammars =
    commands === undefined
      ? undefined
      : normalizeShellCommandGrammars(commands);
  const usage =
    grammars === undefined
      ? undefined
      : harden(grammars.map(formatShellCommandUsage));

  const records = shellToolMethods.map(method => {
    const schema = shellToolSchemas[method];
    const argGuards = positionalArgGuards(method);
    const paramNames = Object.keys(
      /** @type {{ properties?: Record<string, unknown> }} */ (
        schema.parameters
      ).properties || {},
    );
    const description =
      method === 'exec' && usage !== undefined
        ? `${schema.description} Accepted command forms:\n${usage
            .map(line => `  ${line}`)
            .join('\n')}`
        : schema.description;
    return makeTool({
      name: method,
      description,
      parameters: schema.parameters,
      argGuards,
      execute: async argsRecord => {
        if (method === 'exec') {
          const command = /** @type {string} */ (argsRecord.command);
          const argumentVector = /** @type {string[]} */ (
            argsRecord.argumentVector
          );
          // Tool-side grammar pre-match: a better error before the round
          // trip; the capability's own check remains the boundary.
          if (
            grammars !== undefined &&
            !grammars.some(grammar =>
              matchShellCommand(grammar, command, argumentVector),
            )
          ) {
            throw new Error(
              `Command does not match a granted command grammar; usage:\n${(
                usage || []
              )
                .map(line => `  ${line}`)
                .join('\n')}`,
            );
          }
          // Advisory veto before the call reaches the exo.
          veto(command, argumentVector);
        }
        const positional = paramNames.map(paramName => argsRecord[paramName]);
        while (
          positional.length > 0 &&
          positional[positional.length - 1] === undefined
        ) {
          positional.pop();
        }
        const shellMethod = /** @type {keyof ShellToolCapability} */ (method);
        const shell = /** @type {ShellToolDispatch} */ (E(shellCap));
        return shell[shellMethod](...positional);
      },
    });
  });
  return harden(records);
};
harden(makeShellTool);
