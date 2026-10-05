// @ts-check
/// <reference types="ses"/>

import { M } from '@endo/patterns';

// #region Shape primitives

const ShellSlotTypeShape = M.or('string', 'relative-path');

/**
 * One member of an options union: an exact flag token (`'-r'`) or a prefix
 * flag whose glued value is typed (`{ prefix: '--max-count=', type:
 * 'string' }`).
 */
const ShellOptionMemberShape = M.or(
  M.string(),
  M.splitRecord(
    { prefix: M.string(), type: ShellSlotTypeShape },
    { name: M.string() },
    harden({}),
  ),
);

/**
 * One element of a command grammar.  The records are *closed* (explicit empty
 * rest pattern) so a stray property cannot smuggle unvetted meaning past the
 * guard; the deep validation (non-empty tokens, rest-only-last, and so on)
 * lives in `command-grammar.js`, which `makeShell` and `attenuate` both run.
 * Group elements nest, which a pattern cannot express recursively, so the
 * guard admits any record where a nested element may appear and defers the
 * recursive check to that validation.
 */
const ShellCommandElementShape = M.or(
  M.splitRecord({ kind: 'literal', value: M.string() }, {}, harden({})),
  M.splitRecord(
    { kind: 'slot', name: M.string(), type: ShellSlotTypeShape },
    { prefix: M.string(), optional: M.boolean(), description: M.string() },
    harden({}),
  ),
  M.splitRecord(
    { kind: 'options', options: M.arrayOf(ShellOptionMemberShape) },
    {
      optional: M.boolean(),
      repeat: M.boolean(),
      name: M.string(),
      description: M.string(),
    },
    harden({}),
  ),
  M.splitRecord(
    { kind: 'group', elements: M.arrayOf(M.record()) },
    { optional: M.boolean(), repeat: M.boolean(), description: M.string() },
    harden({}),
  ),
  M.splitRecord(
    { kind: 'rest', name: M.string(), type: ShellSlotTypeShape },
    { description: M.string() },
    harden({}),
  ),
);

/**
 * A passable command grammar: a fixed program name and a grammar over its
 * argument tokens (design § Command grammars).
 */
export const ShellCommandGrammarShape = M.splitRecord(
  {
    program: M.string(),
    argumentVector: M.arrayOf(ShellCommandElementShape),
  },
  { description: M.string() },
  harden({}),
);

/**
 * The policy surface `inspect()` reveals to a holder of the Shell cap.
 * Deliberately a *closed* record of exactly the four fields the design's
 * inspect surface names — so the sanitized-env passlist, the baked
 * `searchPath`, and the host working directory (all host-path-bearing) can
 * never leak through `inspect()`.  `M.splitRecord` is *open* by default (its
 * rest pattern defaults to `M.any()`, admitting any extra field), so closing
 * the record takes an explicit empty rest pattern: the leftover, collected as
 * a record, must match `{}`, so any field beyond the named ones is rejected.
 * With the record genuinely closed the returns-guard is a real
 * defense-in-depth net: if a future `inspect()` regressed to include `cwd` /
 * `env` / `searchPath`, the guard would reject the value rather than let a
 * host path escape.
 */
const ShellPolicyShape = M.splitRecord(
  {
    commands: M.arrayOf(ShellCommandGrammarShape),
    usage: M.arrayOf(M.string()),
    timeoutMs: M.number(),
    maxOutputBytes: M.number(),
  },
  undefined,
  harden({}),
);

/**
 * A complete, buffered execution result.  `exitCode` / `signal` are nullable
 * because a process may terminate by signal (code `null`) or be observed with
 * no signal (signal `null`); `truncated` flags that stdout or stderr hit the
 * policy's `maxOutputBytes` cap.
 */
const ShellResultShape = M.splitRecord({
  stdout: M.string(),
  stderr: M.string(),
  exitCode: M.or(M.number(), M.null()),
  signal: M.or(M.string(), M.null()),
  truncated: M.boolean(),
});

/** Per-call options; a per-call `timeoutMs` may only *narrow* the policy's. */
const ExecOptionsShape = M.splitRecord({}, { timeoutMs: M.number() });

/** Attenuation options; `timeoutMs` may only *narrow* along the chain. */
const AttenuateOptionsShape = M.splitRecord(
  {},
  { timeoutMs: M.number() },
  harden({}),
);

// #endregion

/**
 * Runtime guard for the `Shell` exo.  `exec` takes an argv split into
 * `(command, argumentVector[])` — never a shell string — matching the design's Decision
 * 4 (argv arrays only; no shell interpolation on the guest surface).
 * `attenuate` takes passable command grammars and returns a derived `Shell`
 * that can only narrow (it delegates to its parent, so every ancestor's
 * grammar is enforced in turn).
 */
export const ShellInterface = M.interface('Shell', {
  // `callWhen` so the returns guard applies to the *resolved* value (these
  // methods are async); `M.promise(...)` takes a label, not a payload shape,
  // so it cannot constrain the resolution — `callWhen().returns(shape)` can.
  inspect: M.callWhen().returns(ShellPolicyShape),
  exec: M.callWhen(M.string(), M.arrayOf(M.string()))
    .optional(ExecOptionsShape)
    .returns(ShellResultShape),
  attenuate: M.callWhen(M.arrayOf(ShellCommandGrammarShape))
    .optional(AttenuateOptionsShape)
    .returns(M.remotable('Shell')),
});
