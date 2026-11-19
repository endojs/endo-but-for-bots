// @ts-check
/**
 * The environments implementation (`designs/m6-interfaces.md` D-M6-1, 5.2):
 * loaded at run time by `resources/environments/ephemeral.js` after the
 * guest prelude is on `globalThis`. `makeEnvironmentsImpl` composes one
 * adapter incarnation from the modules of `impl/`: the binding
 * (`attach.js`: layout, sweep at bind, the ops facet, pending work) over
 * the parts each binding builds for its settings:
 *
 * - the runtime of `settings.runtime` (`runtime-fake.js`, `runtime-oci.js`)
 *   under the runner (`runner.js`: lazy start, idle stop, allowlist);
 * - the workspace git (`git.js`, over `@endo/git`);
 * - the session's `ShellPort` (`shell-port.js`, staging through the agent
 *   host's writers with `blob-access.js`);
 * - workspace `ImageSource`s (`image-source.js`, seam X-1);
 * - the exec-path `CommandResult` (`command-output.js`).
 */
import { makeTimers } from '../../agent-host/impl/timers.js';
import { makeEnvironmentsBinding } from './attach.js';
import { boundCommandRecord } from './command-output.js';
import { makeWorkspaceGit } from './git.js';
import { openImage } from './image-source.js';
import { makeRunner } from './runner.js';
import { makeFakeRuntime } from './runtime-fake.js';
import { makeOciRuntime } from './runtime-oci.js';
import { makeShellPort } from './shell-port.js';

/** A runtime maker per `runtimeKinds` entry (D-M6-8). */
export const defaultRuntimes = harden({
  fake: () => makeFakeRuntime(),
  podman: () => makeOciRuntime({ binary: 'podman' }),
  docker: () => makeOciRuntime({ binary: 'docker' }),
});

/**
 * The parts of one binding.
 * @param {import('./attach.js').PartsContext} context
 * @returns {import('./attach.js').BindingParts}
 */
export const makeBindingParts = ({
  settings,
  layout,
  runtime,
  timers,
  trace,
}) => {
  const runner = makeRunner({ runtime, settings, layout, timers });
  return harden({
    runner,
    git: makeWorkspaceGit({
      dirsOf: layout.dirsOf,
      ensureWorkspace: layout.ensureWorkspace,
    }),
    ports: (key, { isWithdrawn, redact }) =>
      makeShellPort({
        key,
        runner,
        settings: /** @type {{ allowedCommands: readonly string[] }} */ (
          settings
        ),
        isWithdrawn,
        redact,
        log: (event, fields) => trace({ type: event, key, ...fields }),
      }),
    images: (key, segments, { isWithdrawn }) =>
      openImage({ key, segments, dirsOf: layout.dirsOf, isWithdrawn }),
    commandRecord: raw => boundCommandRecord(raw),
  });
};
harden(makeBindingParts);

/**
 * @param {object} options
 * @param {string} options.incarnation
 * @param {string} [options.stateDir] found from `argv` when absent
 * @param {Record<string, () => any>} [options.runtimes]
 * @param {import('../../agent-host/impl/timers.js').Timers} [options.timers]
 * @param {(event: Record<string, unknown>) => void} [options.trace]
 */
export const makeEnvironmentsImpl = ({
  incarnation,
  stateDir,
  runtimes = defaultRuntimes,
  timers = makeTimers(),
  trace = () => {},
}) =>
  makeEnvironmentsBinding({
    incarnation,
    stateDir,
    runtimes,
    timers,
    trace,
    parts: makeBindingParts,
  });
harden(makeEnvironmentsImpl);
