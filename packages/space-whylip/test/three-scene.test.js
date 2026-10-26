// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { makeThreeScene, validateThreeScene } from '../src/three-scene.js';

/** @import {ExecutionContext} from 'ava' */

/**
 * @param {string} type
 * @param {string} key
 * @param {Record<string, any>} [props]
 * @param {any[]} [children]
 */
const node = (type, key, props = {}, children = []) => ({
  type,
  key,
  props,
  children,
});
/** @param {any[]} children */
const graph = children => node('scene', 'root', {}, children);
/**
 * @param {string} key
 * @param {Record<string, any>} [props]
 */
const box = (key, props = {}) =>
  node('mesh', key, { geometry: { type: 'box' }, ...props });
const camera = () =>
  node('perspectiveCamera', 'camera', {
    position: [0, 0, 5],
    target: [0, 0, 0],
  });

/** @param {ExecutionContext} t */
const fixture = t => {
  /** @type {Map<string, (event: any) => void>} */
  const listeners = new Map();
  /** @type {any[]} */
  const events = [];
  /** @type {{scene: any, camera: any, renders: number, disposed: number, lost: number, size: any, ratio: number}} */
  const observed = {
    scene: undefined,
    camera: undefined,
    renders: 0,
    disposed: 0,
    lost: 0,
    size: undefined,
    ratio: 0,
  };
  const canvas = /** @type {any} */ ({
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 100,
    }),
  });
  const controller = makeThreeScene(canvas, {
    pixelRatio: 2,
    onEvent: event => events.push(event),
    makeRenderer: () => ({
      setPixelRatio: ratio => {
        observed.ratio = ratio;
      },
      setSize: (...size) => {
        observed.size = size;
      },
      render: (scene, view) => {
        observed.scene = scene;
        observed.camera = view;
        observed.renders += 1;
      },
      dispose: () => {
        observed.disposed += 1;
      },
      forceContextLoss: () => {
        observed.lost += 1;
      },
    }),
  });
  t.teardown(() => controller.dispose());
  return {
    controller,
    observed,
    listeners,
    events,
    click: () => listeners.get('click')?.({ clientX: 60, clientY: 70 }),
  };
};

test('validation copies data, accepts h children, and freezes only the canonical graph', t => {
  const material = { color: '#ABC', side: 'double' };
  const tree = {
    type: 'scene',
    key: 'root',
    props: { children: [null, false, [box('one', { material })]] },
    constructor: undefined,
  };
  const validated = validateThreeScene(tree);
  t.is(validated.children.length, 1);
  t.is(validated.children[0].props.material.color, '#abc');
  t.true(Object.isFrozen(validated.children[0].props.geometry.args));
  t.false(Object.isFrozen(material));
  material.color = '#def';
  t.is(validated.children[0].props.material.color, '#abc');
  t.notThrows(() =>
    validateThreeScene({ __proto__: null, type: 'scene', key: 'root' }),
  );
});

test('validation rejects authority, ambiguous keys, accessors, and unsafe numeric inputs', t => {
  let reads = 0;
  const accessor = {
    type: 'box',
    get width() {
      reads += 1;
      return 1;
    },
  };
  for (const tree of [
    graph([box('a', { ref: {} })]),
    graph([box('a', { onClick: () => {} })]),
    graph([box('a'), box('a')]),
    graph([box('a', { geometry: accessor })]),
    graph([box('a', { position: [0, NaN, 0] })]),
    graph([box('a', { material: { color: 'url(x)' } })]),
    graph([box('a', { geometry: { type: 'box', radius: 2 } })]),
    graph([
      box('a', { geometry: { type: 'sphere', widthSegments: Infinity } }),
    ]),
    graph([
      box('a', {
        geometry: { type: 'cylinder', radiusTop: 0, radiusBottom: 0 },
      }),
    ]),
    graph([node('perspectiveCamera', 'a'), node('perspectiveCamera', 'b')]),
    graph([node('perspectiveCamera', 'a', { near: 10, far: 1 })]),
    graph([
      node('perspectiveCamera', 'a', { target: [0, 0, 0], lookAt: [0, 0, 0] }),
    ]),
    graph([node('ambientLight', 'a', {}, [box('b')])]),
    { ...graph([]), constructor: Function },
    { ...graph([]), props: { key: 'other' } },
  ])
    t.throws(() => validateThreeScene(tree), { instanceOf: Error });
  t.is(reads, 0);
});

test('validation bounds nodes, depth, total vertices, and empty-array traversal', t => {
  t.throws(
    () =>
      validateThreeScene(
        graph(Array.from({ length: 256 }, (_, i) => box(`b${i}`))),
      ),
    { message: /size budget/ },
  );
  let deep = box('box');
  for (let i = 0; i < 25; i += 1) deep = node('group', `g${i}`, {}, [deep]);
  t.throws(() => validateThreeScene(graph([deep])), { message: /size budget/ });
  t.throws(
    () =>
      validateThreeScene(
        graph(
          Array.from({ length: 16 }, (_, i) =>
            box(`s${i}`, {
              geometry: {
                type: 'sphere',
                widthSegments: 64,
                heightSegments: 64,
              },
            }),
          ),
        ),
      ),
    { message: /vertex budget/ },
  );
  t.throws(
    () =>
      validateThreeScene(
        graph(Array.from({ length: 256 }, () => Array(256).fill(null))),
      ),
    { message: /size budget/ },
  );
});

test('keyed objects, camera, and unchanged resources survive reorder and reparent', t => {
  const { controller, observed } = fixture(t);
  controller.update(
    graph([
      camera(),
      node('group', 'left', {}, [box('a'), box('b')]),
      node('group', 'right'),
    ]),
  );
  const a = observed.scene.getObjectByName('a');
  const b = observed.scene.getObjectByName('b');
  const geometry = a.geometry;
  const material = a.material;
  const view = observed.camera;
  controller.update(
    graph([
      node('group', 'right', {}, [box('a', { position: [1, 2, 3] })]),
      camera(),
      node('group', 'left', {}, [box('b')]),
    ]),
  );
  t.is(observed.scene.getObjectByName('a'), a);
  t.is(observed.scene.getObjectByName('b'), b);
  t.is(a.parent.name, 'right');
  t.deepEqual(a.position.toArray(), [1, 2, 3]);
  t.is(a.geometry, geometry);
  t.is(a.material, material);
  t.is(observed.camera, view);
  t.deepEqual(
    observed.scene.children.map(child => child.name),
    ['right', 'camera', 'left'],
  );
  controller.update(
    graph([node('group', 'right', {}, [box('b'), box('a')]), camera()]),
  );
  t.deepEqual(
    observed.scene.getObjectByName('right').children.map(child => child.name),
    ['b', 'a'],
  );
  controller.resize(640, 320);
  t.deepEqual(observed.size, [640, 320, false]);
  t.is(observed.camera.aspect, 2);
  t.is(observed.ratio, 2);
});

test('malformed updates leave the previous complete live scene unchanged', t => {
  const { controller, observed } = fixture(t);
  controller.update(graph([box('a')]));
  const a = observed.scene.getObjectByName('a');
  const geometry = a.geometry;
  const renders = observed.renders;
  t.throws(
    () =>
      controller.update(
        graph([
          box('a', { position: [9, 9, 9], geometry: { type: 'sphere' } }),
          box('bad', { geometry: { type: 'arbitrary' } }),
        ]),
      ),
    { message: /Unsupported scene geometry/ },
  );
  t.is(observed.scene.getObjectByName('a'), a);
  t.is(a.geometry, geometry);
  t.deepEqual(a.position.toArray(), [0, 0, 0]);
  t.is(observed.renders, renders);
  t.is(observed.scene.children.length, 1);
});

test('changed and removed mesh resources dispose exactly once; renderer cleanup is idempotent', t => {
  const { controller, observed, listeners } = fixture(t);
  controller.update(graph([box('a')]));
  const a = observed.scene.getObjectByName('a');
  let geometries = 0;
  let materials = 0;
  a.geometry.addEventListener('dispose', () => {
    geometries += 1;
  });
  a.material.addEventListener('dispose', () => {
    materials += 1;
  });
  controller.update(
    graph([
      box('a', { geometry: { type: 'sphere' }, material: { color: '#f00' } }),
    ]),
  );
  t.is(observed.scene.getObjectByName('a'), a);
  t.is(geometries, 1);
  t.is(materials, 1);
  a.geometry.addEventListener('dispose', () => {
    geometries += 1;
  });
  a.material.addEventListener('dispose', () => {
    materials += 1;
  });
  controller.update(graph([node('group', 'a')]));
  t.is(geometries, 2);
  t.is(materials, 2);
  controller.update(graph([box('final')]));
  const final = observed.scene.getObjectByName('final');
  final.geometry.addEventListener('dispose', () => {
    geometries += 1;
  });
  final.material.addEventListener('dispose', () => {
    materials += 1;
  });
  controller.dispose();
  controller.dispose();
  t.is(geometries, 3);
  t.is(materials, 3);
  t.is(observed.disposed, 1);
  t.is(observed.lost, 1);
  t.is(listeners.size, 0);
  t.throws(() => controller.update(graph([])), { message: /disposed/ });
});

test('all permitted primitives and lights construct after SES lockdown', t => {
  const { controller, observed } = fixture(t);
  const types = ['box', 'sphere', 'cone', 'cylinder', 'plane', 'torus'];
  controller.update(
    graph([
      ...types.map(type => box(type, { geometry: { type } })),
      node('ambientLight', 'ambient', { intensity: 0.4 }),
      node('directionalLight', 'sun', { target: [1, 2, 3], color: '#f80' }),
      node('pointLight', 'point', { distance: 8, decay: 1 }),
      node('perspectiveCamera', 'camera', {
        position: [0, 0, 5],
        lookAt: [0, 0, 0],
      }),
    ]),
  );
  for (const type of types)
    t.is(
      observed.scene.getObjectByName(type).geometry.type.toLowerCase(),
      `${type}geometry`,
    );
  const sun = observed.scene.getObjectByName('sun');
  t.is(sun.target.parent, observed.scene);
  t.deepEqual(sun.target.position.toArray(), [1, 2, 3]);
  t.is(observed.scene.getObjectByName('point').distance, 8);
  controller.update(graph([]));
  t.is(sun.target.parent, null);
  t.is(observed.scene.children.length, 0);
});

test('picking emits frozen data, updates callback ids, respects hidden objects and occlusion', t => {
  const { controller, click, events } = fixture(t);
  controller.update(graph([camera(), box('target', { onClick: 'first' })]));
  controller.resize(100, 100);
  click();
  t.like(events[0], { type: 'click', id: 'first', key: 'target' });
  t.deepEqual(Object.keys(events[0]).sort(), ['id', 'key', 'point', 'type']);
  t.deepEqual(events[0].point, [0, 0, 0.5]);
  t.true(Object.isFrozen(events[0]));
  t.true(Object.isFrozen(events[0].point));
  controller.update(
    graph([
      camera(),
      box('target', { onClick: 'second' }),
      box('foreground', { position: [0, 0, 2] }),
    ]),
  );
  click();
  t.is(events.length, 1);
  controller.update(
    graph([
      camera(),
      box('target', { onClick: 'second' }),
      node('group', 'hidden', { visible: false }, [
        box('foreground', { position: [0, 0, 2] }),
      ]),
    ]),
  );
  click();
  t.is(events[1].id, 'second');
  controller.update(graph([camera(), box('target')]));
  click();
  t.is(events.length, 2);
});
