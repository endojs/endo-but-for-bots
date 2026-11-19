// @ts-check
/**
 * The shell tools' arguments, parsed in the environments adapter from the
 * model's JSON text (`designs/m6-interfaces.md` 3.6; R4-43, R4-45). A vat
 * never parses them (rule 12.10): a record of 20,000 keys exists only here,
 * for one call, and is refused by name before anything runs.
 *
 * `runCommand`: closed keys `command`, `args`, `options` (`timeoutMs`);
 * `command` a name on the allowlist (names, never paths: `/bin/sh` is not
 * `sh`); `args` an array of strings, at most `maxCommandArgs`, together at
 * most `commandArgsBytes` UTF-8 bytes, each at most `commandArgUnits` (the
 * exec path's guard, so both paths take the same commands);
 * `options.timeoutMs` a positive timer-range integer. `inspectShell`: the
 * empty closed object. Blank arguments read as `{}` (as the session's
 * built-in tools read them).
 *
 * Texts: Fae's (`textOf.unexpectedArgument`, `argumentsNotJson`), the
 * harness's `invalidArgument`, and the environments texts (`notAllowed`,
 * `timeoutInvalid`, `argsTooLarge`).
 *
 * Node only (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentLimits,
  environmentTexts,
  environmentTextOf,
} from '../../../guest/lib/guards/environments.js';
import { shellToolArgumentNames } from '../../../guest/lib/guards/session.js';
import { textOf } from '../../../guest/lib/interfaces.js';
import { utf8Bytes } from '../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

const L = environmentLimits;

/**
 * @typedef {{ ok: true, command: string, args: string[], timeoutMs?: number }} ParsedCommand
 * @typedef {{ ok: false, text: string }} ArgsRefusal
 */

/**
 * @param {string} text
 * @returns {ArgsRefusal}
 */
const refuse = text => harden({ ok: false, text });

/**
 * The model's JSON as a plain object, or the refusal.
 * @param {string} jsonText
 * @returns {{ value: Record<string, unknown> } | ArgsRefusal}
 */
const parseObject = jsonText => {
  if (typeof jsonText !== 'string') {
    return refuse(textOf.argumentsNotJson('the arguments are not text'));
  }
  if (jsonText.trim() === '') return { value: {} };
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    return refuse(
      textOf.argumentsNotJson(
        /** @type {Error} */ (error)?.message ?? String(error),
      ),
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse(
      textOf.argumentsNotJson('the arguments must be a JSON object'),
    );
  }
  return { value: /** @type {Record<string, unknown>} */ (value) };
};

/**
 * The first key of `value` not in `allowed`, compared by name.
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 */
const unexpectedKey = (value, allowed) =>
  Object.keys(value).find(key => !allowed.includes(key));

/**
 * @param {unknown} value
 */
const isTimerRange = value =>
  Number.isSafeInteger(value) &&
  /** @type {number} */ (value) > 0 &&
  /** @type {number} */ (value) <= L.maxCommandTimeoutMs;

/**
 * Parse `runCommand`'s arguments.
 *
 * @param {string} jsonText
 * @param {readonly string[]} allowed the allowlist (program names)
 * @returns {ParsedCommand | ArgsRefusal}
 */
export const parseCommandArgs = (jsonText, allowed) => {
  const parsed = parseObject(jsonText);
  if (!('value' in parsed)) return parsed;
  const { value } = parsed;
  const names = shellToolArgumentNames.runCommand;
  const extra = unexpectedKey(value, names);
  if (extra !== undefined) {
    return refuse(textOf.unexpectedArgument(extra, 'runCommand', names));
  }
  for (const name of ['command', 'args']) {
    if (!Object.hasOwn(value, name)) {
      return refuse(textOf.argumentsNotJson(`argument "${name}" is required`));
    }
  }
  const { command, args, options } = value;
  if (typeof command !== 'string') {
    return refuse(textOf.invalidArgument('command', 'runCommand', 'a string'));
  }
  if (!allowed.includes(command)) {
    return refuse(environmentTextOf.notAllowed(command));
  }
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    return refuse(
      textOf.invalidArgument('args', 'runCommand', 'an array of strings'),
    );
  }
  if (args.length > L.maxCommandArgs) {
    return refuse(
      textOf.invalidArgument(
        'args',
        'runCommand',
        `an array of at most ${L.maxCommandArgs} strings`,
      ),
    );
  }
  let bytes = 0;
  for (const arg of args) bytes += utf8Bytes(arg);
  if (bytes > L.commandArgsBytes) {
    return refuse(environmentTextOf.argsTooLarge(bytes, L.commandArgsBytes));
  }
  if (args.some(arg => arg.length > L.commandArgUnits || arg.includes('\0'))) {
    return refuse(
      textOf.invalidArgument(
        'args',
        'runCommand',
        `strings of at most ${L.commandArgUnits} characters without NUL`,
      ),
    );
  }
  /** @type {number | undefined} */
  let timeoutMs;
  if (options !== undefined) {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    ) {
      return refuse(
        textOf.invalidArgument('options', 'runCommand', 'a JSON object'),
      );
    }
    const record = /** @type {Record<string, unknown>} */ (options);
    const optionNames = shellToolArgumentNames.options;
    const extraOption = unexpectedKey(record, optionNames);
    if (extraOption !== undefined) {
      return refuse(
        textOf.unexpectedArgument(
          extraOption,
          'runCommand options',
          optionNames,
        ),
      );
    }
    if (record.timeoutMs !== undefined) {
      if (!isTimerRange(record.timeoutMs)) {
        return refuse(environmentTexts.timeoutInvalid);
      }
      timeoutMs = /** @type {number} */ (record.timeoutMs);
    }
  }
  return harden({
    ok: true,
    command,
    args: harden([...args]),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
};
harden(parseCommandArgs);

/**
 * Parse `inspectShell`'s arguments: the empty closed object.
 *
 * @param {string} jsonText
 * @returns {{ ok: true } | ArgsRefusal}
 */
export const parseInspectArgs = jsonText => {
  const parsed = parseObject(jsonText);
  if (!('value' in parsed)) return parsed;
  const extra = unexpectedKey(
    parsed.value,
    shellToolArgumentNames.inspectShell,
  );
  if (extra !== undefined) {
    return refuse(
      textOf.unexpectedArgument(
        extra,
        'inspectShell',
        shellToolArgumentNames.inspectShell,
      ),
    );
  }
  return harden({ ok: true });
};
harden(parseInspectArgs);
