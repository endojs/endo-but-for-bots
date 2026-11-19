// @ts-check
/**
 * Gateway extensions by file (M3 W3.2; designs/m3-interfaces.md D-M3-4,
 * 6.1). Later milestones add gateway services, routes, large-call
 * exemptions and CSP sources as files under `GW/extensions/`; nobody edits
 * an M3 file to add one.
 *
 * `loadGatewayExtensions({ dir?, log })` loads every `*.js` of `dir` in
 * name order (synchronously, with `require`: no top-level await) and
 * answers the valid `gatewayExtension` exports. A file that throws while
 * loading, has no `gatewayExtension` export, or whose export does not have
 * the contract's shape (`protocol.js` `GatewayExtension`) is logged
 * `{ event: 'gateway-extension-skip', file, error }` and skipped; the
 * gateway still serves. A route on a path the gateway keeps (`/`, `/ws`,
 * `/assets/*`) or that an earlier file took makes its file invalid.
 *
 * The helpers below turn the loaded list into what the gateway wiring
 * (W3.7, `GW/index.js`) hands the server and the bridge:
 * `makeExtensionServices` (the `GatewayPowers.extras`, at most
 * `m3Limits.extras`), `extensionRoutes`, `extensionCsp` and
 * `makeLargeCalls` (the bridge's `isLargeCall`, extension targets resolved
 * once per incarnation after `whenAttached`, compared by identity).
 *
 * Node module (agent-host adapter).
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { m3Limits } from '../../../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import { WS_PATH } from './protocol.js';
import { markGatewayLocal } from './powers.js';

/** @import { GatewayContext, GatewayExtension, GatewayRoute } from './protocol.js' */

const require = createRequire(import.meta.url);

/** `GW/extensions/` (the default `dir`). */
export const defaultExtensionsDir = fileURLToPath(
  new URL('./extensions/', import.meta.url),
);

/** A CSP directive name, and a source without separators. */
const directivePattern = /^[a-z][a-z-]*$/;
const sourcePattern = /^[^\s;,]+$/;

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * @param {string} path
 * @returns {boolean}
 */
const isReservedPath = path =>
  path === '/' ||
  path === WS_PATH ||
  path === '/assets' ||
  path.startsWith('/assets/');

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringList = value =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * Check one export against `GatewayExtension`; throws what is wrong.
 * @param {any} extension
 * @param {Set<string>} takenPaths routes of earlier files
 * @returns {GatewayExtension}
 */
const validate = (extension, takenPaths) => {
  if (extension === null || typeof extension !== 'object') {
    throw Error('no gatewayExtension export');
  }
  const {
    name,
    services = [],
    routes = [],
    largeCalls = [],
    csp = {},
  } = extension;
  if (typeof name !== 'string' || name === '') throw Error('no name');
  if (!Array.isArray(services)) throw Error('services is not an array');
  for (const service of services) {
    if (
      typeof service?.label !== 'string' ||
      service.label === '' ||
      typeof service.make !== 'function'
    ) {
      throw Error('a service needs a label and make(context)');
    }
  }
  if (!Array.isArray(routes)) throw Error('routes is not an array');
  /** @type {Set<string>} */
  const ownPaths = new Set();
  for (const route of routes) {
    if (route?.kind !== 'http' && route?.kind !== 'upgrade') {
      throw Error('a route kind is http or upgrade');
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw Error('a route path starts with /');
    }
    if (typeof route.handle !== 'function') throw Error('a route needs handle');
    const key = `${route.kind} ${route.path}`;
    if (isReservedPath(route.path)) {
      throw Error(`route ${route.path} is the gateway's own`);
    }
    if (takenPaths.has(key) || ownPaths.has(key)) {
      throw Error(`route ${route.path} is taken`);
    }
    ownPaths.add(key);
  }
  if (!Array.isArray(largeCalls)) throw Error('largeCalls is not an array');
  for (const largeCall of largeCalls) {
    if (
      typeof largeCall?.target !== 'function' ||
      !isStringList(largeCall.methods) ||
      largeCall.methods.length === 0
    ) {
      throw Error('a large call needs target(context) and methods');
    }
  }
  if (csp === null || typeof csp !== 'object' || Array.isArray(csp)) {
    throw Error('csp is not a record');
  }
  for (const [directive, sources] of Object.entries(csp)) {
    if (!directivePattern.test(directive)) {
      throw Error(`csp directive ${directive} is not a directive name`);
    }
    if (
      !isStringList(sources) ||
      !sources.every(source => sourcePattern.test(source))
    ) {
      throw Error(`csp ${directive} sources are not plain sources`);
    }
  }
  for (const key of ownPaths) takenPaths.add(key);
  return extension;
};

/**
 * Load every extension file of `dir` (m3-interfaces.md 6.1).
 * @param {object} options
 * @param {string} [options.dir] default `GW/extensions/`
 * @param {(event: Record<string, unknown>) => void} options.log
 * @returns {GatewayExtension[]}
 */
export const loadGatewayExtensions = ({ dir = defaultExtensionsDir, log }) => {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir)
      .filter(name => name.endsWith('.js'))
      .sort();
  } catch {
    return [];
  }
  /** @type {Set<string>} */
  const takenPaths = new Set();
  /** @type {GatewayExtension[]} */
  const loaded = [];
  for (const name of names) {
    try {
      // Extension files are found by listing the directory (6.1).
      // eslint-disable-next-line import/no-dynamic-require
      const module = require(join(dir, name));
      loaded.push(validate(module.gatewayExtension, takenPaths));
      log({ event: 'gateway-extension-loaded', file: name });
    } catch (error) {
      log({
        event: 'gateway-extension-skip',
        file: name,
        error: messageOf(error),
      });
    }
  }
  return loaded;
};
harden(loadGatewayExtensions);

/**
 * The extras services of one incarnation: the gateway's own (`builtIn`,
 * first: the page's secret writer, `GW/index.js`), then the extensions' in
 * file then array order, at most `m3Limits.extras` in all. A `make` that
 * throws, or a label already used, is logged and skipped.
 * Each `make` receives `contextFor(extension)` (`GW/index.js`: the
 * extension's own context, with its `ExtensionPowers` if it has any);
 * without `contextFor`, `context`.
 * @param {object} options
 * @param {GatewayExtension[]} options.extensions
 * @param {GatewayContext} [options.context]
 * @param {(extension: GatewayExtension) => GatewayContext} [options.contextFor]
 * @param {(event: Record<string, unknown>) => void} options.log
 * @param {{ label: string, service: any }[]} [options.builtIn]
 * @returns {{ label: string, service: any }[]}
 */
export const makeExtensionServices = ({
  extensions,
  context,
  contextFor = () => /** @type {GatewayContext} */ (context),
  log,
  builtIn = [],
}) => {
  /** @type {{ label: string, service: any }[]} */
  const extras = builtIn.map(({ label, service }) =>
    harden({ label, service }),
  );
  /** @type {Set<string>} */
  const labels = new Set(builtIn.map(({ label }) => label));
  for (const extension of extensions) {
    for (const { label, make } of extension.services ?? []) {
      /** @type {string | undefined} */
      let error;
      if (labels.has(label)) {
        error = 'label taken';
      } else if (extras.length >= m3Limits.extras) {
        error = 'too many services';
      } else {
        try {
          extras.push(harden({ label, service: make(contextFor(extension)) }));
          labels.add(label);
        } catch (failure) {
          error = messageOf(failure);
        }
      }
      if (error !== undefined) {
        log({
          event: 'gateway-service-skip',
          extension: extension.name,
          label,
          error,
        });
      }
    }
  }
  return harden(extras);
};
harden(makeExtensionServices);

/**
 * Every extension route, in file order (paths validated at load).
 * @param {GatewayExtension[]} extensions
 * @returns {GatewayRoute[]}
 */
export const extensionRoutes = extensions =>
  harden(extensions.flatMap(extension => extension.routes ?? []));
harden(extensionRoutes);

/**
 * The CSP sources extensions add, per directive (merged, no duplicates);
 * the argument of `csp.js` `cspHeader(extra)`.
 * @param {GatewayExtension[]} extensions
 * @returns {Record<string, string[]>}
 */
export const extensionCsp = extensions => {
  /** @type {Map<string, Set<string>>} */
  const merged = new Map();
  for (const extension of extensions) {
    for (const [directive, sources] of Object.entries(extension.csp ?? {})) {
      const set = merged.get(directive) ?? new Set();
      for (const source of sources) set.add(source);
      merged.set(directive, set);
    }
  }
  return harden(
    Object.fromEntries(
      [...merged].map(([directive, set]) => [directive, [...set]]),
    ),
  );
};
harden(extensionCsp);

/**
 * The bridge's `isLargeCall` (m3-interfaces.md 4.4 rule 3, 6.1): the
 * built-in exemptions (the Composer's `submit` and `edit`) at once, each
 * extension's `target(context)` awaited once after `whenAttached`. A target
 * that rejects is logged and has no exemption. Each `target` receives
 * `contextFor(extension)` (default: `context`, whose `whenAttached` is
 * used either way).
 * @param {object} options
 * @param {GatewayExtension[]} options.extensions
 * @param {GatewayContext} options.context
 * @param {(extension: GatewayExtension) => GatewayContext} [options.contextFor]
 * @param {{ target: unknown, methods: string[] }[]} [options.builtIn]
 * @param {(event: Record<string, unknown>) => void} options.log
 * @returns {{ isLargeCall: (target: unknown, method: string) => boolean, ready: Promise<void> }}
 */
export const makeLargeCalls = ({
  extensions,
  context,
  contextFor = () => context,
  builtIn = [],
  log,
}) => {
  /** @type {Map<unknown, Set<string>>} */
  const exempt = new Map();
  /**
   * @param {unknown} target
   * @param {string[]} methods
   */
  const add = (target, methods) => {
    // A LargeCall target is an object of this process (CC-050 workaround).
    markGatewayLocal(target);
    const set = exempt.get(target) ?? new Set();
    for (const method of methods) set.add(method);
    exempt.set(target, set);
  };
  for (const { target, methods } of builtIn) add(target, methods);

  const pending = extensions.flatMap(extension =>
    (extension.largeCalls ?? []).map(largeCall => ({
      name: extension.name,
      extension,
      largeCall,
    })),
  );
  /** @type {Promise<void>} */
  const ready = new Promise(resolve => {
    if (pending.length === 0) {
      resolve();
      return;
    }
    context.whenAttached(() => {
      const resolving = pending.map(({ name, extension, largeCall }) =>
        Promise.resolve()
          .then(() => largeCall.target(contextFor(extension)))
          .then(
            target => add(target, largeCall.methods),
            error =>
              log({
                event: 'gateway-large-call-skip',
                extension: name,
                error: messageOf(error),
              }),
          ),
      );
      void Promise.all(resolving).then(() => resolve());
    });
  });

  return harden({
    isLargeCall: (target, method) => exempt.get(target)?.has(method) === true,
    ready,
  });
};
harden(makeLargeCalls);
