// @ts-check

import { makeError, X } from '@endo/errors';
import { confineComponent } from '@endo/preact-container/compartment';
import { Fragment } from 'preact';

import { validateThreeScene } from './three-scene.js';

/** @import { ComponentChildren, FunctionComponent } from 'preact' */

/** @typedef {Record<string, unknown>} StoryState */
/** @typedef {{ source: string, children?: ComponentChildren, assets?: Record<string, string>, state?: StoryState, onAction?: (name: string, detail: unknown) => void, onState?: (patch: StoryState) => void }} SceneProps */
/** @typedef {(tools: object, props: object) => unknown} SceneFunction */
/** @typedef {(event: any) => unknown} SceneEventHandler */

/**
 * Copy data at the scene boundary. Accessors, cycles, functions and non-JSON
 * values are rejected rather than passed to the host as latent capabilities.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {any}
 */
const copyData = (value, depth = 0) => {
  if (depth > 64) throw makeError(X`Story data is too deeply nested`);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw makeError(X`Story state and actions must contain JSON data`);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        throw makeError(X`Story arrays must contain data values`);
      }
      items.push(copyData(descriptor.value, depth + 1));
    }
    return items;
  }
  const result = { __proto__: null };
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (descriptor.enumerable) {
      if (!('value' in descriptor)) {
        throw makeError(X`Story data must not contain getters`);
      }
      result[key] = copyData(descriptor.value, depth + 1);
    }
  }
  return result;
};

/**
 * Guest h builds inert descriptions. It never returns a host Preact vnode with
 * private parent/component/DOM fields. confineComponent rebuilds descriptions
 * with the real h before the existing confined renderer admits them.
 * @param {unknown} type
 * @param {Record<string, unknown> | null} props
 * @param {...unknown} children
 */
const sceneH = (type, props, ...children) => ({
  constructor: undefined,
  type,
  key: props?.key,
  props: { ...props, ...(children.length ? { children } : {}) },
});
harden(sceneH);
const sceneTools = harden({ h: sceneH, Fragment });

/**
 * Snapshot the entire result before activation, so a failed render or malformed
 * descendant cannot replace the last working scene halfway through a DOM diff.
 * Functions are only admitted as event handlers; guest component/hook identities
 * cannot change across a live source update.
 * @param {any} value
 * @param {(handler: SceneEventHandler) => SceneEventHandler} wrapEvent
 * @param {number} [depth]
 * @returns {any}
 */
const copyTree = (value, wrapEvent, depth = 0) => {
  if (depth > 128) throw makeError(X`Scene tree is too deeply nested`);
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const children = [];
    for (let index = 0; index < value.length; index += 1) {
      children.push(copyTree(value[index], wrapEvent, depth + 1));
    }
    return children;
  }
  if (typeof value !== 'object') {
    throw makeError(X`Scenes must return elements, text, or arrays`);
  }
  const { type, props = {}, key } = value;
  if (typeof type !== 'string' && type !== Fragment) {
    throw makeError(
      X`Use HTML elements or Fragment; scene hooks are not available`,
    );
  }
  const result = { __proto__: null };
  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(props),
  )) {
    if (!('value' in descriptor)) {
      throw makeError(X`Scene properties must not contain getters`);
    }
    const prop = descriptor.value;
    if (name === 'children') {
      result.children = copyTree(prop, wrapEvent, depth + 1);
    } else if (/^on/i.test(name) && typeof prop === 'function') {
      result[name] = wrapEvent(prop);
    } else if (name === 'style' && prop !== null && typeof prop === 'object') {
      result.style = copyData(prop);
    } else if (name !== 'ref' && prop !== undefined) {
      result[name] = copyData(prop);
    }
  }
  if (key !== undefined) result.key = copyData(key);
  return sceneH(type, result);
};

/**
 * Copy an inert scene description, replacing guest callbacks with opaque IDs.
 * Budget the copy itself: a small shared-array DAG can otherwise expand long
 * before the graph validator sees it. Each occurrence consumes the same budget.
 * @param {any} value
 * @param {Map<string, SceneEventHandler>} handlers
 * @param {(handler: SceneEventHandler) => SceneEventHandler} wrapEvent
 * @param {number} [depth]
 * @param {{ visits: number, properties: number, characters: number }} [budget]
 * @returns {any}
 */
const copyWorld = (
  value,
  handlers,
  wrapEvent,
  depth = 0,
  budget = { visits: 0, properties: 0, characters: 0 },
) => {
  budget.visits += 1;
  if (budget.visits > 16_384)
    throw makeError(X`Scene description exceeds its copy budget`);
  if (depth > 64) throw makeError(X`Scene description is too deeply nested`);
  if (typeof value === 'string') {
    budget.characters += value.length;
    if (budget.characters > 1_048_576)
      throw makeError(X`Scene description exceeds its text budget`);
  }
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return copyData(value);
  if (Array.isArray(value)) {
    if (value.length > 256) throw makeError(X`Scene array is too large`);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor))
        throw makeError(X`Scene arrays must contain data`);
      return copyWorld(
        descriptor.value,
        handlers,
        wrapEvent,
        depth + 1,
        budget,
      );
    });
  }
  const result = { __proto__: null };
  const names = Reflect.ownKeys(value);
  budget.properties += names.length;
  if (budget.properties > 16_384)
    throw makeError(X`Scene description exceeds its property budget`);
  for (const name of names) {
    if (typeof name !== 'string')
      throw makeError(X`Scene properties must have string names`);
    budget.characters += name.length;
    if (budget.characters > 1_048_576)
      throw makeError(X`Scene description exceeds its text budget`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor))
      throw makeError(X`Scene properties must not contain getters`);
    if (name === 'onClick' && typeof descriptor.value === 'function') {
      const id = `click-${handlers.size}`;
      handlers.set(id, wrapEvent(descriptor.value));
      result[name] = id;
    } else if (descriptor.value !== undefined) {
      result[name] = copyWorld(
        descriptor.value,
        handlers,
        wrapEvent,
        depth + 1,
        budget,
      );
    }
  }
  return result;
};

/**
 * Create a stable confined component for one book surface. Never key this
 * component by source/revision: reconciliation must retain the reader's DOM.
 * The source is an expression `({ h, Fragment }, { state, act, update }) => ...`.
 * Live-authorable scenes are pure render functions; reader state belongs to
 * the book session, outside code that the agent can replace.
 */
export const makeSceneRuntime = () => {
  /** @type {string | undefined} */
  let attemptedSource;
  /** @type {string | undefined} */
  let activeSource;
  /** @type {SceneFunction | undefined} */
  let active;
  /** @type {any} */
  let lastTree = null;
  /** @type {any} */
  let world = null;
  /** @type {Map<string, SceneEventHandler>} */
  let sceneHandlers = new Map();
  /** @type {string | null} */
  let error = null;

  /** @param {unknown} reason */
  const recordError = reason => {
    error = 'The scene could not be rendered.';
    try {
      const message = reason instanceof Error ? reason.message : reason;
      if (typeof message === 'string') error = message.slice(0, 1000);
    } catch (_err) {
      // Even a thrown Error may have a hostile message getter.
    }
  };

  /** @type {FunctionComponent<SceneProps>} */
  const Component = confineComponent(
    (_endowments, rawProps) => {
      const {
        source,
        state = {},
        assets = {},
        onAction,
        onState,
      } = /** @type {SceneProps} */ (rawProps);
      let rendering = true;
      let dispatching = false;
      const assertInteractive = () => {
        if (rendering || !dispatching)
          throw makeError(
            X`Call act or update from event handlers, not during render`,
          );
      };
      /** @param {SceneEventHandler} handler */
      const wrapEvent = handler =>
        harden(event => {
          dispatching = true;
          try {
            handler(event);
          } finally {
            dispatching = false;
          }
        });
      /** @param {unknown} result */
      const stage = result => {
        const sceneDescriptor =
          result && typeof result === 'object'
            ? Object.getOwnPropertyDescriptor(result, 'scene')
            : undefined;
        if (!sceneDescriptor)
          return {
            tree: copyTree(result, wrapEvent),
            world: null,
            handlers: new Map(),
          };
        if (!('value' in sceneDescriptor))
          throw makeError(X`Scene must be a data property`);
        const overlayDescriptor = Object.getOwnPropertyDescriptor(
          result,
          'overlay',
        );
        if (overlayDescriptor && !('value' in overlayDescriptor))
          throw makeError(X`Overlay must be a data property`);
        const handlers = new Map();
        const nextWorld = copyWorld(sceneDescriptor.value, handlers, wrapEvent);
        validateThreeScene(nextWorld);
        const tree = copyTree(overlayDescriptor?.value ?? null, wrapEvent);
        return { tree, world: harden(nextWorld), handlers };
      };
      const commit = staged => {
        lastTree = staged.tree;
        world = staged.world;
        sceneHandlers = staged.handlers;
        return lastTree;
      };
      const props = harden({
        state: harden(copyData(state)),
        asset: path => {
          if (
            typeof path !== 'string' ||
            !path.startsWith('assets/') ||
            !path.endsWith('.svg') ||
            !Object.hasOwn(assets, path)
          )
            return '';
          const svg = assets[path];
          return typeof svg === 'string'
            ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
            : '';
        },
        act: (name, detail = {}) => {
          assertInteractive();
          if (typeof name !== 'string' || !name || name.length > 160) {
            throw makeError(
              X`Story action names must be short, nonempty strings`,
            );
          }
          onAction?.(name, harden(copyData(detail)));
        },
        update: patch => {
          assertInteractive();
          if (
            patch === null ||
            typeof patch !== 'object' ||
            Array.isArray(patch)
          ) {
            throw makeError(X`Story updates must be object patches`);
          }
          onState?.(harden(copyData(patch)));
        },
      });
      try {
        if (source !== attemptedSource) {
          attemptedSource = source;
          try {
            // No browser, timers, network, filesystem, console or host globals.
            const candidate = new Compartment().evaluate(`(${source}\n)`);
            if (typeof candidate !== 'function') {
              throw makeError(
                X`Scene source must evaluate to a render function`,
              );
            }
            const staged = stage(candidate(sceneTools, props));
            active = candidate;
            activeSource = source;
            commit(staged);
            error = null;
            return lastTree;
          } catch (reason) {
            recordError(reason);
          }
        }
        if (active) {
          try {
            commit(stage(active(sceneTools, props)));
            if (source === activeSource) error = null;
          } catch (reason) {
            recordError(reason);
          }
        }
        return lastTree;
      } finally {
        rendering = false;
      }
    },
    { name: 'LivingStoryScene', onError: recordError },
  );

  return harden({
    Component,
    getError: () => error,
    getScene: () => world,
    dispatchSceneEvent: event => {
      const data = harden(copyData(event));
      sceneHandlers.get(data.id)?.(data);
    },
  });
};
harden(makeSceneRuntime);
