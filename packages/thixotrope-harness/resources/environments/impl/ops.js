// @ts-check
/**
 * The environments adapter's ops facet (`designs/m6-interfaces.md` 3.3,
 * 5.2): one per binding of the service key, attached to the manager's sink;
 * the manager vat is its only caller. `key` is the manager's `e<n>`: here
 * it names directories and a container, and it never goes further.
 *
 * Policy lives in the adapter, not in the manager (D-M6-13); here: the
 * image refusal, the withdrawn keys of emergency-stopped
 * environments (D-M6-9: their `ShellPort` and `ImageSource` calls are
 * refused here, from the first call of an incarnation, since `ready`
 * settles only after `attach` answered them), and no host path in any
 * failure (D-M6-14: the workspace becomes `/workspace`, the home
 * `/home/node`, the state directory `<state>`).
 *
 * The parts it calls are the other modules' (`git.js`, `runner.js`, the
 * shell port, the image source, the exec-path record of
 * `command-output.js`), handed in by the composition (`index.js`), so this
 * module is tested with fakes of their contract shapes.
 *
 * Node only (adapter; the guest prelude is on `globalThis`).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentInterfaces as I,
  environmentLimits as L,
  environmentTextOf,
  environmentTexts as T,
} from '../../../guest/lib/guards/environments.js';
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { WorkspaceSeed } from './layout.js' */

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @typedef {object} Runner the runner's contract shape (`runner.js`, 5.2)
 * @property {(key: string, argv: string[], options: { timeoutMs: number }) => Promise<any>} exec
 *   a `RawResult` (5.3)
 * @property {() => any} inspect a `ShellInfo`
 * @property {(key: string) => Promise<void>} stop
 * @property {(key: string) => Promise<void>} release
 * @property {() => Promise<unknown>} sweep
 * @property {() => number} runningCount
 */

/**
 * @typedef {object} WorkspaceGit the workspace git's contract shape
 * @property {(key: string, request: { op: string, args: unknown[] }, options: { readOnly: boolean }) => Promise<unknown>} run
 * @property {(key: string) => Promise<boolean>} removeStaleLock
 * @property {(key: string) => void} forget
 */

/**
 * @typedef {object} AdapterSideOptions what an adapter-side object of a key
 *   is made with
 * @property {(key: string) => boolean} isWithdrawn whether the key is
 *   refused now (emergency stop, D-M6-9)
 * @property {(text: string) => string} redact a failure's text without
 *   host paths (D-M6-14)
 */

/**
 * @typedef {object} OpsPowers
 * @property {Record<string, any>} settings the binding's `EnvironmentSettings`
 * @property {import('./layout.js').Layout} layout
 * @property {WorkspaceGit} git the workspace git (`git.js` `makeWorkspaceGit`)
 * @property {Runner} runner
 * @property {(key: string, options: AdapterSideOptions) => any} ports
 *   makes the key's `ShellPort` (`shell-port.js` `makeShellPort`), once per
 *   key here
 * @property {(key: string, segments: string[], options: AdapterSideOptions) => Promise<any>} images
 *   opens an `ImageSource` (`image-source.js` `openImage`: path rules and
 *   the file checked first)
 * @property {(raw: any) => any} commandRecord the exec-path `CommandResult`
 *   (`command-output.js` `boundCommandRecord`)
 * @property {(refresh: boolean) => PromiseLike<{ ok: boolean, reason?: string }> | { ok: boolean, reason?: string }} check the binding's image check
 * @property {Set<string>} withdrawn the keys refused here (filled from
 *   `PendingWork.withdrawn`, then by `stop(key, { withdraw: true })`)
 * @property {Promise<unknown>} [ready] settles once `attach` answered
 * @property {readonly string[]} [hiddenPaths] state directory spellings
 *   no failure may name
 */

/**
 * @param {OpsPowers} powers
 */
export const makeOps = ({
  settings,
  layout,
  git,
  runner,
  ports,
  images,
  commandRecord,
  check,
  withdrawn,
  ready = Promise.resolve(),
  hiddenPaths = [],
}) => {
  /**
   * One `ShellPort` per key for this binding (the same presence on a
   * repeat); deleted at release, so bounded by the manager's records.
   * @type {Map<string, any>}
   */
  const portOf = new Map();
  /** @param {string} key */
  const isWithdrawn = key => withdrawn.has(key);

  /**
   * A text without host paths, bounded: the key's workspace becomes
   * `/workspace` and its home `/home/node` (their names in a container),
   * any other spelling of the state directory `<state>`.
   * @param {string} text
   * @param {string} [key]
   */
  const redactFor = (text, key) => {
    let out = text;
    if (key !== undefined) {
      const dirs = layout.dirsOf(key);
      out = out
        .split(dirs.workspace)
        .join('/workspace')
        .split(dirs.home)
        .join('/home/node');
    }
    for (const path of hiddenPaths)
      if (path !== '') out = out.split(path).join('<state>');
    return out.slice(0, limits.reasonUnits);
  };

  /**
   * @param {unknown} error
   * @param {string} [key]
   */
  const hidden = (error, key) => {
    const message = /** @type {any} */ (error)?.message;
    return Error(
      redactFor(typeof message === 'string' ? message : String(error), key),
    );
  };

  /** @param {string} key */
  const sideOptions = key =>
    harden({
      isWithdrawn,
      redact: (/** @type {string} */ text) => redactFor(text, key),
    });

  /**
   * Run `fn` after `ready`, its failure without host paths.
   * @template T
   * @param {string | undefined} key
   * @param {() => Promise<T> | T} fn
   * @param {{ refuseWithdrawn?: boolean, seed?: WorkspaceSeed }} [options]
   * @returns {Promise<T>}
   */
  const serve = async (key, fn, { refuseWithdrawn = true, seed } = {}) => {
    await ready;
    if (refuseWithdrawn && key !== undefined && withdrawn.has(key))
      throw Error(T.stopped);
    try {
      if (key !== undefined && seed !== undefined)
        layout.registerSeed(key, seed);
      return await fn();
    } catch (error) {
      throw hidden(error, key);
    }
  };

  return makeExo('EnvironmentsOps', I.EnvironmentsOps, {
    status: async () => {
      await ready;
      const { ok, reason } = await check(true);
      return harden({
        state: ok ? 'ready' : 'refused',
        environments: 0,
        pendingStops: 0,
        pendingReleases: 0,
        runtime: settings.runtime,
        running: runner.runningCount(),
        ...(ok ? {} : { error: reason ?? T.imageRefused }),
      });
    },
    /**
     * @param {string} key
     * @param {{ op: string, args: unknown[] }} request
     * @param {WorkspaceSeed} [seed]
     */
    git: (key, request, seed) =>
      serve(key, () => git.run(key, request, { readOnly: false }), { seed }),
    /**
     * @param {string} key
     * @param {string} command
     * @param {string[]} args
     * @param {{ timeoutMs?: number }} options
     * @param {WorkspaceSeed} [seed]
     */
    runCommand: (key, command, args, options, seed) =>
      serve(
        key,
        async () => {
          const checked = await check(false);
          if (!checked.ok) throw Error(checked.reason ?? T.imageRefused);
          // The runner checks the allowlist and the timeout (exo-shell's
          // rules) on every path; a timeout rejects as exo-shell does, the
          // partial output dropped (5.5).
          const timeoutMs =
            options.timeoutMs ??
            settings.defaultTimeoutMs ??
            L.defaultCommandTimeoutMs;
          const raw = await runner.exec(key, [command, ...args], { timeoutMs });
          if (raw.timedOut) throw Error(environmentTextOf.timedOut(timeoutMs));
          return commandRecord(raw);
        },
        { seed },
      ),
    /** @param {string} key */
    inspect: key =>
      serve(key, () => runner.inspect(), { refuseWithdrawn: false }),
    /**
     * @param {string} key
     * @param {string[]} segments
     * @param {WorkspaceSeed} [seed]
     */
    openImage: (key, segments, seed) =>
      serve(
        key,
        async () => {
          if (seed !== undefined) await layout.ensureWorkspace(key);
          return images(key, segments, sideOptions(key));
        },
        { seed },
      ),
    /**
     * @param {string} key
     * @param {WorkspaceSeed} [seed]
     */
    port: (key, seed) =>
      serve(
        key,
        () => {
          let port = portOf.get(key);
          if (port === undefined) {
            port = ports(key, sideOptions(key));
            portOf.set(key, port);
          }
          return port;
        },
        { seed },
      ),
    /**
     * @param {string} key
     * @param {{ withdraw?: boolean }} [options]
     */
    stop: (key, { withdraw = false } = {}) =>
      serve(
        key,
        async () => {
          if (withdraw) withdrawn.add(key);
          await runner.stop(key);
          return undefined;
        },
        { refuseWithdrawn: false },
      ),
    /** @param {string} key */
    resume: key =>
      serve(
        key,
        () => {
          withdrawn.delete(key);
          return undefined;
        },
        { refuseWithdrawn: false },
      ),
    /** @param {string} key */
    release: key =>
      serve(
        key,
        async () => {
          withdrawn.delete(key);
          portOf.delete(key);
          await runner.release(key);
          git.forget(key);
          await layout.release(key);
          return undefined;
        },
        { refuseWithdrawn: false },
      ),
  });
};
harden(makeOps);
