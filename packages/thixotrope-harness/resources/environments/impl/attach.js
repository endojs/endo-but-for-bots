// @ts-check
/**
 * The adapter half of the environments attach pattern
 * (`designs/m6-interfaces.md` D-M6-3, 4.7, 4.8): the `bind` and `unbind`
 * the service key's registration runs.
 *
 * `bind(key, spec)` with `spec = { sink, settings }`:
 * 1. the layout (once per incarnation) and its tag;
 * 2. the runtime of `settings.runtime` and its image check (a refused
 *    check binds anyway: status says `refused`, every command fails with
 *    `imageRefused`, git still works);
 * 3. the parts (git, runner, shell ports, image sources, the exec-path
 *    record) for these settings;
 * 4. at the incarnation's first bind only: the runner's sweep (every
 *    container or fake process group this state owns: a SIGKILL's
 *    leftovers), the trash, stale `index.lock` files; nothing starts;
 * 5. the ops facet, attached to the sink; the answer's withdrawn keys are
 *    refused before the facet serves its first call;
 * 6. the pending stops and releases, performed after `bind` answers and
 *    reported to the sink (`stopped`, `released`), sendOnly.
 *
 * A bind under new settings (the operator configured again) comes after
 * the unbind of the old binding, which sweeps what the old runner ran.
 *
 * Node only (adapter).
 */
import { E } from '@endo/far';
import { existsSync, realpathSync } from 'node:fs';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { environmentTexts as T } from '../../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */
import { findStateDir } from '../../native-layout.js';
import { makeTimers } from '../../agent-host/impl/timers.js';
import { makeLayout } from './layout.js';
import { makeOps } from './ops.js';

/** The one registration key (the manager's `SERVICE_KEY`). */
export const SERVICE_KEY = 'environments';

/**
 * @typedef {object} BindingParts what a binding builds for its settings
 * @property {import('./ops.js').OpsPowers['git']} git
 * @property {import('./ops.js').Runner} runner
 * @property {import('./ops.js').OpsPowers['ports']} ports
 * @property {import('./ops.js').OpsPowers['images']} images
 * @property {import('./ops.js').OpsPowers['commandRecord']} commandRecord
 */

/**
 * @typedef {object} PartsContext
 * @property {Record<string, any>} settings
 * @property {import('./layout.js').Layout} layout
 * @property {any} runtime the `Runtime` of `settings.runtime` (5.3)
 * @property {string} tag
 * @property {import('../../agent-host/impl/timers.js').Timers} timers adapter timers
 * @property {(event: Record<string, unknown>) => void} trace
 */

/**
 * @param {object} options
 * @param {string} options.incarnation
 * @param {(context: PartsContext) => BindingParts} options.parts
 * @param {Record<string, () => any>} options.runtimes a runtime maker per
 *   `runtimeKinds` entry
 * @param {string} [options.stateDir] found from `argv` when absent, once
 * @param {import('../../agent-host/impl/timers.js').Timers} [options.timers]
 * @param {(event: Record<string, unknown>) => void} [options.trace]
 */
export const makeEnvironmentsBinding = ({
  incarnation,
  parts,
  runtimes,
  stateDir: givenStateDir,
  timers = makeTimers(),
  trace = () => {},
}) => {
  /** @type {import('./layout.js').Layout | undefined} */
  let layout;
  /** @type {string[]} */
  let hiddenPaths = [];
  let swept = false;
  /** @type {{ runner: import('./ops.js').Runner } | undefined} */
  let current;

  const layoutNow = () => {
    if (layout === undefined) {
      const stateDir = givenStateDir ?? findStateDir();
      hiddenPaths = [stateDir];
      if (existsSync(stateDir)) {
        const real = realpathSync(stateDir);
        if (real !== stateDir) hiddenPaths.push(real);
      }
      layout = makeLayout({ stateDir, incarnation });
    }
    return layout;
  };

  /**
   * Perform the work the manager still owes, then report it, sendOnly.
   * @param {any} sink
   * @param {import('./ops.js').Runner} runner
   * @param {import('./layout.js').Layout} here
   * @param {{ stops: string[], releases: string[] }} work
   */
  const performPending = async (sink, runner, here, work) => {
    /** @type {string[]} */
    const stopped = [];
    for (const key of work.stops) {
      // eslint-disable-next-line no-await-in-loop -- one at a time, after bind
      await runner.stop(key).then(
        () => stopped.push(key),
        error => trace({ type: 'pending-stop-failed', key, error: `${error}` }),
      );
    }
    if (stopped.length > 0) E.sendOnly(sink).stopped(harden(stopped));
    /** @type {string[]} */
    const released = [];
    for (const key of work.releases) {
      // eslint-disable-next-line no-await-in-loop -- one at a time, after bind
      await runner
        .release(key)
        .then(() => here.release(key))
        .then(
          () => released.push(key),
          error =>
            trace({ type: 'pending-release-failed', key, error: `${error}` }),
        );
    }
    if (released.length > 0) E.sendOnly(sink).released(harden(released));
  };

  /**
   * @param {unknown} key
   * @param {{ sink: any, settings: Record<string, any> }} spec
   */
  const bind = async (key, spec) => {
    if (key !== SERVICE_KEY)
      throw Error(`environments have no registration ${JSON.stringify(key)}`);
    const { sink, settings } = spec;
    const here = layoutNow();
    const tag = here.tag();
    const makeRuntime = Object.hasOwn(runtimes, settings.runtime)
      ? runtimes[settings.runtime]
      : undefined;
    if (makeRuntime === undefined)
      throw Error(`environments have no runtime ${settings.runtime}`);
    const runtime = makeRuntime();
    /** @type {{ ok: boolean, reason?: string }} */
    const checked = await Promise.resolve()
      .then(() => runtime.check(settings))
      .catch(() => ({ ok: false, reason: T.imageRefused }));
    trace({ type: 'bind', runtime: settings.runtime, ok: checked.ok });
    const built = parts({
      settings,
      layout: here,
      runtime,
      tag,
      timers,
      trace,
    });
    if (!swept) {
      swept = true;
      await built.runner.sweep();
      await here.sweepTrash();
      for (const workspaceKey of await here.keys())
        // eslint-disable-next-line no-await-in-loop -- one at a time, at bind
        await built.git.removeStaleLock(workspaceKey);
    }
    /** @type {Set<string>} */
    const withdrawn = new Set();
    /** @type {(value?: unknown) => void} */
    let open = () => {};
    const ready = new Promise(resolve => {
      open = resolve;
    });
    const ops = makeOps({
      settings,
      layout: here,
      git: built.git,
      runner: built.runner,
      ports: built.ports,
      images: built.images,
      commandRecord: built.commandRecord,
      check: () => checked,
      withdrawn,
      ready,
      hiddenPaths,
    });
    let work;
    try {
      work = await E(sink).attach(ops, incarnation);
      for (const withdrawnKey of work.withdrawn) withdrawn.add(withdrawnKey);
    } finally {
      // Never leave a facet's calls waiting: a failed attach means the
      // manager never received it, so nothing calls it.
      open();
    }
    current = { runner: built.runner };
    void performPending(sink, built.runner, here, work).catch(error =>
      trace({ type: 'pending-failed', error: `${error}` }),
    );
    return harden({ key });
  };

  /**
   * Releasing the binding (new settings replace it): what its runner runs
   * is swept, so the next binding starts from nothing running.
   * @param {unknown} _binding
   * @param {unknown} _key
   */
  const unbind = async (_binding, _key) => {
    const previous = current;
    current = undefined;
    if (previous !== undefined) await previous.runner.sweep();
    return undefined;
  };

  return harden({ bind, unbind });
};
harden(makeEnvironmentsBinding);
