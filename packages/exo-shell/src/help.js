// @ts-check

/** Documentation shared by host and durable environment Shell facets. */
const documentation = harden({
  '':
    'Shell executes bounded argv commands. inspect() reports effective limits. ' +
    'Background processes have no persistence guarantee; this is not a service host. ' +
    'Use help("exec") for execution and recovery guidance.',
  inspect:
    'inspect() -> Promise<{allowedCommands, timeoutMs, maxOutputBytes}>. ' +
    'Limits are effective: output previews are at most 65536 bytes per stream. ' +
    'No host path, credentials, or environment administration is exposed.',
  exec:
    'exec(command, args, {timeoutMs}?) -> Promise<{stdout, stderr, exitCode, signal, truncated}>. ' +
    'Pass structured argv. Use sh with -lc for shell syntax if it is allowlisted. ' +
    'Inspect stderr and exitCode; pipelines can mask earlier failures. ' +
    'Output is truncated and drained; save full logs in a file before returning an excerpt. ' +
    'Run a local test server, readiness check, browser test, and cleanup in one invocation. ' +
    'A background child or listener need not survive the invocation or a turn. ' +
    'A retained daemon controller and a larger timeout do not grant persistent hosting. ' +
    'Timeouts and rejected calls may already have effects: inspect state before retrying mutations. ' +
    'Do not clear locks without proving their owner exited. ' +
    'After failed native execution, cleanup must finish before another command can run. ' +
    'If execution remains stopped, report that operator cleanup is required.',
});

/** @param {string} [method] */
export const shellHelp = (method = '') =>
  Object.hasOwn(documentation, method)
    ? documentation[method]
    : 'No documentation available for that method.';
harden(shellHelp);
