// @ts-check
// Counts the exos guest modules make with `defineExoClass` (J-9152): import
// it after `_m1a-prelude.js` and before any guest module, so the modules
// read the counting `defineExoClass` from `globalThis`. Every instance is
// kept only through a WeakRef; `liveExos()` forces a full collection first
// (V8's `gc`, enabled here at run time) and counts the instances still
// reachable, by tag.
import v8 from 'node:v8';
import vm from 'node:vm';

v8.setFlagsFromString('--expose_gc');
/** @type {() => void} */
const gc = vm.runInNewContext('gc');

const original = /** @type {any} */ (globalThis).defineExoClass;

/** @type {{ tag: string, ref: WeakRef<object> }[]} */
const made = [];

/**
 * @param {string} tag
 * @param {...any} rest
 */
const countingDefineExoClass = (tag, ...rest) => {
  const make = original(tag, ...rest);
  return harden((/** @type {any[]} */ ...args) => {
    const exo = make(...args);
    made.push({ tag, ref: new WeakRef(exo) });
    return exo;
  });
};

Object.defineProperty(globalThis, 'defineExoClass', {
  value: harden(countingDefineExoClass),
  writable: false,
  enumerable: false,
  configurable: true,
});

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Exos made so far that are still reachable after a full collection, by tag.
 * @returns {Promise<{ made: Record<string, number>, live: Record<string, number> }>}
 */
export const liveExos = async () => {
  // A WeakRef keeps its target until the end of the job that read it.
  await tick();
  gc();
  await tick();
  gc();
  /** @type {Record<string, number>} */
  const live = {};
  /** @type {Record<string, number>} */
  const all = {};
  for (const { tag, ref } of made) {
    all[tag] = (all[tag] ?? 0) + 1;
    if (ref.deref() !== undefined) live[tag] = (live[tag] ?? 0) + 1;
  }
  return { made: all, live };
};
