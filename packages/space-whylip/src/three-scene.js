// @ts-check

import { makeError } from '@endo/errors';
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  WebGLRenderer,
} from 'three';

/** @typedef {{type: string, key: string, props: Record<string, any>, children: ThreeNode[]}} ThreeNode */
/** @typedef {{type: 'click', id: string, key: string, point: number[]}} ThreeSceneEvent */

const MAX_NODES = 256;
const MAX_DEPTH = 24;
const MAX_VERTICES = 65_536;
const TRANSFORM_PROPS = harden(['position', 'rotation', 'scale', 'visible']);
const TYPES = harden([
  'scene',
  'group',
  'mesh',
  'ambientLight',
  'directionalLight',
  'pointLight',
  'perspectiveCamera',
]);

/**
 * @param {string} message
 * @returns {never}
 */
const fail = message => {
  throw makeError(message);
};

/**
 * Read only own data properties. No accessor, prototype, or unknown field can
 * become authority to construct or mutate a Three object.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} label
 * @returns {Record<string, any>}
 */
const record = (value, allowed, label) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail(`${label} must be a plain data record`);
  /** @type {Record<string, any>} */
  const result = { __proto__: null };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key))
      return fail(`${label} contains an unsupported field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      return fail(`${label} must not contain accessors`);
    result[key] = descriptor.value;
  }
  return result;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
const number = (value, fallback, min, max) => {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    return fail('Scene number is outside its permitted range');
  return value;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
const integer = (value, fallback, min, max) => {
  const result = number(value, fallback, min, max);
  if (!Number.isInteger(result))
    return fail('Scene segment counts must be integers');
  return result;
};

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
const boolean = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return fail('Scene flag must be a boolean');
  return value;
};

/**
 * @param {unknown} value
 * @param {string} fallback
 */
const color = (value, fallback) => {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
  )
    return fail('Scene colors must be hexadecimal RGB strings');
  return value.toLowerCase();
};

/**
 * @param {unknown} value
 * @param {number[]} fallback
 * @param {number} [min]
 * @param {number} [max]
 */
const vector = (value, fallback, min = -10_000, max = 10_000) => {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== 3)
    return fail('Scene vectors must contain three numbers');
  const result = [];
  for (let index = 0; index < 3; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !('value' in descriptor) ||
      descriptor.value === undefined
    )
      return fail('Scene vectors must contain own numeric data');
    result.push(number(descriptor.value, 0, min, max));
  }
  return result;
};

/** @param {Record<string, any>} props */
const transforms = props => ({
  position: vector(props.position, [0, 0, 0]),
  rotation: vector(props.rotation, [0, 0, 0], -1000, 1000),
  scale: vector(props.scale, [1, 1, 1], 0.001, 1000),
  visible: boolean(props.visible, true),
});

/** @param {unknown} value */
const geometry = value => {
  const input = record(
    value,
    [
      'type',
      'width',
      'height',
      'depth',
      'radius',
      'radiusTop',
      'radiusBottom',
      'tube',
      'widthSegments',
      'heightSegments',
      'radialSegments',
      'tubularSegments',
      'arc',
    ],
    'Geometry',
  );
  const { type } = input;
  /** @type {string[]} */
  let fields;
  /** @type {number[]} */
  let args;
  let vertices;
  /**
   * @param {string} name
   * @param {number} [fallback]
   */
  const size = (name, fallback = 1) =>
    number(input[name], fallback, 0.001, 1000);
  /**
   * @param {string} name
   * @param {number} fallback
   * @param {number} [min]
   */
  const segments = (name, fallback, min = 1) =>
    integer(input[name], fallback, min, 64);
  switch (type) {
    case 'box':
      fields = ['width', 'height', 'depth'];
      args = [size('width'), size('height'), size('depth')];
      vertices = 24;
      break;
    case 'sphere':
      fields = ['radius', 'widthSegments', 'heightSegments'];
      args = [
        size('radius'),
        segments('widthSegments', 16, 3),
        segments('heightSegments', 12, 2),
      ];
      vertices = (args[1] + 1) * (args[2] + 1);
      break;
    case 'cone':
      fields = ['radius', 'height', 'radialSegments'];
      args = [
        size('radius'),
        size('height'),
        segments('radialSegments', 16, 3),
      ];
      vertices = 6 * (args[2] + 1);
      break;
    case 'cylinder':
      fields = ['radiusTop', 'radiusBottom', 'height', 'radialSegments'];
      args = [
        number(input.radiusTop, 1, 0, 1000),
        number(input.radiusBottom, 1, 0, 1000),
        size('height'),
        segments('radialSegments', 16, 3),
      ];
      if (args[0] === 0 && args[1] === 0)
        return fail('Cylinder needs a nonzero radius');
      vertices = 6 * (args[3] + 1);
      break;
    case 'plane':
      fields = ['width', 'height', 'widthSegments', 'heightSegments'];
      args = [
        size('width'),
        size('height'),
        segments('widthSegments', 1),
        segments('heightSegments', 1),
      ];
      vertices = (args[2] + 1) * (args[3] + 1);
      break;
    case 'torus':
      fields = ['radius', 'tube', 'radialSegments', 'tubularSegments', 'arc'];
      args = [
        size('radius'),
        size('tube', 0.3),
        segments('radialSegments', 8, 3),
        segments('tubularSegments', 24, 3),
        number(input.arc, 2 * Math.PI, 0.001, 2 * Math.PI),
      ];
      vertices = (args[2] + 1) * (args[3] + 1);
      break;
    default:
      return fail('Unsupported scene geometry');
  }
  if (Object.keys(input).some(key => key !== 'type' && !fields.includes(key)))
    return fail('Geometry field does not apply to this primitive');
  return { type, args, vertices };
};

/** @param {unknown} value */
const material = value => {
  const input = record(
    value ?? {},
    [
      'color',
      'emissive',
      'emissiveIntensity',
      'roughness',
      'metalness',
      'opacity',
      'wireframe',
      'side',
    ],
    'Material',
  );
  const side = input.side ?? 'front';
  if (!['front', 'back', 'double'].includes(side))
    return fail('Unsupported material side');
  return {
    color: color(input.color, '#b8c8dc'),
    emissive: color(input.emissive, '#000000'),
    emissiveIntensity: number(input.emissiveIntensity, 1, 0, 10),
    roughness: number(input.roughness, 0.8, 0, 1),
    metalness: number(input.metalness, 0, 0, 1),
    opacity: number(input.opacity, 1, 0, 1),
    wireframe: boolean(input.wireframe, false),
    side,
  };
};

/**
 * Validate and snapshot the complete graph before any host objects change.
 * Keys identify objects across reordering and reparenting, not just siblings.
 * @param {unknown} tree
 * @returns {ThreeNode}
 */
export const validateThreeScene = tree => {
  const keys = new Set();
  let count = 0;
  let vertices = 0;
  let cameras = 0;
  let childSlots = 0;
  /**
   * @param {unknown} value
   * @param {number} depth
   * @param {boolean} root
   * @returns {ThreeNode}
   */
  const visit = (value, depth, root = false) => {
    if (depth > MAX_DEPTH || count >= MAX_NODES)
      return fail('Scene graph exceeds its size budget');
    count += 1;
    const node = record(
      value,
      ['type', 'key', 'props', 'children', 'constructor'],
      'Scene node',
    );
    if (node.constructor !== undefined)
      return fail('Scene nodes cannot supply constructors');
    if (!TYPES.includes(node.type) || (node.type === 'scene') !== root)
      return fail('Scene needs one scene root and supported child node types');
    const allowed = ['key', 'children', ...TRANSFORM_PROPS];
    if (node.type === 'scene') allowed.push('background');
    if (node.type === 'mesh') allowed.push('geometry', 'material', 'onClick');
    if (node.type.endsWith('Light')) allowed.push('color', 'intensity');
    if (node.type === 'directionalLight' || node.type === 'perspectiveCamera')
      allowed.push('target', 'lookAt');
    if (node.type === 'pointLight') allowed.push('distance', 'decay');
    if (node.type === 'perspectiveCamera') allowed.push('fov', 'near', 'far');
    const input = record(node.props ?? {}, allowed, 'Scene properties');
    const key = node.key ?? input.key;
    if (typeof key !== 'string' || !key || key.length > 160 || keys.has(key))
      return fail(
        'Scene keys must be unique, nonempty strings of at most 160 characters',
      );
    if (
      node.key !== undefined &&
      input.key !== undefined &&
      node.key !== input.key
    )
      return fail('Scene node and property keys must agree');
    keys.add(key);
    /** @type {Record<string, any>} */
    const props = transforms(input);
    if (node.type === 'scene')
      props.background = color(input.background, '#101827');
    if (node.type === 'mesh') {
      props.geometry = geometry(input.geometry);
      props.material = material(input.material);
      vertices += props.geometry.vertices;
      if (vertices > MAX_VERTICES)
        return fail('Scene geometry exceeds its vertex budget');
      if (input.onClick !== undefined) {
        if (
          typeof input.onClick !== 'string' ||
          !input.onClick ||
          input.onClick.length > 160
        )
          return fail('Scene click handlers must be opaque event identifiers');
        props.onClick = input.onClick;
      }
    }
    if (node.type.endsWith('Light')) {
      props.color = color(input.color, '#ffffff');
      props.intensity = number(input.intensity, 1, 0, 100);
    }
    if (node.type === 'pointLight') {
      props.distance = number(input.distance, 0, 0, 10_000);
      props.decay = number(input.decay, 2, 0, 4);
    }
    if (node.type === 'directionalLight' || node.type === 'perspectiveCamera') {
      if (input.target !== undefined && input.lookAt !== undefined)
        return fail('Specify camera or light target once');
      props.target = vector(input.target ?? input.lookAt, [0, 0, 0]);
    }
    if (node.type === 'perspectiveCamera') {
      cameras += 1;
      if (cameras > 1)
        return fail('Scene can contain only one perspective camera');
      props.fov = number(input.fov, 45, 10, 120);
      const near = number(input.near, 0.1, 0.001, 100);
      const far = number(input.far, 1000, 0.01, 100_000);
      props.near = near;
      props.far = far;
      if (far <= near)
        return fail('Camera far plane must exceed its near plane');
    }
    if (node.children !== undefined && input.children !== undefined)
      return fail('Specify scene children once');
    /** @type {ThreeNode[]} */
    const children = [];
    /**
     * @param {any} child
     * @param {number} arrayDepth
     */
    const append = (child, arrayDepth = 0) => {
      childSlots += 1;
      if (childSlots > 2048)
        fail('Scene child arrays exceed their size budget');
      if (child === null || child === undefined || typeof child === 'boolean')
        return;
      if (!Array.isArray(child)) {
        children.push(visit(child, depth + 1));
        return;
      }
      if (arrayDepth > MAX_DEPTH || child.length > MAX_NODES)
        fail('Scene child arrays exceed their size budget');
      for (let index = 0; index < child.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          child,
          String(index),
        );
        if (!descriptor || !('value' in descriptor)) {
          fail('Scene children must be data elements');
        } else {
          append(descriptor.value, arrayDepth + 1);
        }
      }
    };
    append(node.children ?? input.children);
    if (!['scene', 'group', 'mesh'].includes(node.type) && children.length)
      return fail('Lights and cameras cannot contain scene children');
    return { type: node.type, key, props, children };
  };
  return harden(visit(tree, 0, true));
};
harden(validateThreeScene);

/** @param {{type: string, args: number[]}} spec */
const makeGeometry = spec => {
  const [a, b, c, d, e] = spec.args;
  switch (spec.type) {
    case 'box':
      return new BoxGeometry(a, b, c);
    case 'sphere':
      return new SphereGeometry(a, b, c);
    case 'cone':
      return new ConeGeometry(a, b, c);
    case 'cylinder':
      return new CylinderGeometry(a, b, c, d);
    case 'plane':
      return new PlaneGeometry(a, b, c, d);
    case 'torus':
      return new TorusGeometry(a, b, c, d, e);
    default:
      return fail('Unsupported scene geometry');
  }
};

/** @param {ReturnType<typeof material>} spec */
const makeMaterial = spec =>
  new MeshStandardMaterial({
    ...spec,
    side: { front: FrontSide, back: BackSide, double: DoubleSide }[spec.side],
    transparent: spec.opacity < 1,
  });

/**
 * Host-owned Three renderer. Its callbacks contain only frozen coordinates and
 * opaque event IDs; no Three, canvas, renderer, or DOM reference crosses back.
 * A renderer factory is an optional host-only seam for headless tests.
 * @param {HTMLCanvasElement} canvas
 * @param {{onEvent?: (event: ThreeSceneEvent) => void, makeRenderer?: (canvas: HTMLCanvasElement) => any, pixelRatio?: number}} [options]
 */
export const makeThreeScene = (
  canvas,
  {
    onEvent,
    makeRenderer = element =>
      new WebGLRenderer({ canvas: element, antialias: true }),
    pixelRatio = 1,
  } = {},
) => {
  const ratio = number(pixelRatio, 1, 0.5, 2);
  const renderer = makeRenderer(canvas);
  renderer.setPixelRatio(ratio);
  const scene = new Scene();
  const defaultCamera = new PerspectiveCamera(45, 1, 0.1, 1000);
  defaultCamera.position.set(0, 3, 8);
  defaultCamera.lookAt(0, 0, 0);
  let camera = defaultCamera;
  let width = 1;
  let height = 1;
  let disposed = false;
  /** @type {Map<string, {object: any, type: string, geometry?: string, material?: string, eventId?: string}>} */
  let entries = new Map();
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  /** @param {any} entry */
  const release = entry => {
    entry.object.removeFromParent();
    if (entry.type === 'mesh') {
      entry.object.geometry.dispose();
      entry.object.material.dispose();
    }
    if (entry.type === 'directionalLight')
      entry.object.target.removeFromParent();
  };
  const render = () => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    scene.updateMatrixWorld(true);
    renderer.render(scene, camera);
  };
  /** @param {MouseEvent} event */
  const click = event => {
    if (disposed || !onEvent) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    pointer.set(
      (2 * (event.clientX - bounds.left)) / bounds.width - 1,
      1 - (2 * (event.clientY - bounds.top)) / bounds.height,
    );
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    // Uninteractive foreground meshes still occlude clickable objects behind.
    const meshes = [...entries.values()]
      .filter(entry => entry.type === 'mesh')
      .map(entry => entry.object);
    const hits = raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      /** @type {any} */
      let object = hit.object;
      let visible = true;
      while (object) {
        if (!object.visible) visible = false;
        object = object.parent;
      }
      if (visible) {
        const entry = entries.get(hit.object.name);
        if (entry?.eventId)
          onEvent(
            harden({
              type: 'click',
              id: entry.eventId,
              key: hit.object.name,
              point: hit.point.toArray(),
            }),
          );
        break;
      }
    }
  };
  canvas.addEventListener('click', click);
  return harden({
    /** @param {unknown} tree */
    update(tree) {
      if (disposed) fail('Three scene is disposed');
      const graph = validateThreeScene(tree);
      const next = new Map();
      /** @type {{object: PerspectiveCamera, target: number[]}[]} */
      const seenCameras = [];
      /**
       * @param {ThreeNode} node
       * @param {any} parent
       */
      const reconcile = (node, parent) => {
        let entry = entries.get(node.key);
        if (entry && entry.type !== node.type) {
          release(entry);
          entry = undefined;
        }
        if (!entry) {
          let object;
          switch (node.type) {
            case 'scene':
              object = scene;
              break;
            case 'group':
              object = new Group();
              break;
            case 'mesh':
              object = new Mesh();
              break;
            case 'ambientLight':
              object = new AmbientLight();
              break;
            case 'directionalLight':
              object = new DirectionalLight();
              break;
            case 'pointLight':
              object = new PointLight();
              break;
            case 'perspectiveCamera':
              object = new PerspectiveCamera();
              break;
            default:
              fail('Unsupported scene node');
          }
          entry = { object, type: node.type };
        }
        const { object } = entry;
        const { props } = node;
        object.name = node.key;
        object.position.fromArray(props.position);
        object.rotation.set(...props.rotation);
        object.scale.fromArray(props.scale);
        object.visible = props.visible;
        if (parent) parent.add(object);
        if (node.type === 'scene')
          scene.background = new Color(props.background);
        if (node.type === 'mesh') {
          const geometryKey = JSON.stringify(props.geometry);
          const materialKey = JSON.stringify(props.material);
          if (entry.geometry !== geometryKey) {
            const replacement = makeGeometry(props.geometry);
            object.geometry.dispose();
            object.geometry = replacement;
            entry.geometry = geometryKey;
          }
          if (entry.material !== materialKey) {
            const replacement = makeMaterial(props.material);
            object.material.dispose();
            object.material = replacement;
            entry.material = materialKey;
          }
          entry.eventId = props.onClick;
        }
        if (node.type.endsWith('Light')) {
          object.color.set(props.color);
          object.intensity = props.intensity;
        }
        if (node.type === 'pointLight') {
          object.distance = props.distance;
          object.decay = props.decay;
        }
        if (node.type === 'directionalLight') {
          object.target.position.fromArray(props.target);
          if (object.target.parent !== scene) scene.add(object.target);
        }
        if (node.type === 'perspectiveCamera') {
          object.fov = props.fov;
          object.near = props.near;
          object.far = props.far;
          seenCameras.push({ object, target: props.target });
        }
        next.set(node.key, entry);
        node.children.forEach(child => reconcile(child, object));
      };
      reconcile(graph, undefined);
      for (const [key, entry] of entries) if (!next.has(key)) release(entry);
      entries = next;
      scene.updateMatrixWorld(true);
      camera = seenCameras[0]?.object ?? defaultCamera;
      if (seenCameras.length) {
        const [x, y, z] = seenCameras[0].target;
        camera.lookAt(x, y, z);
      }
      render();
    },
    /**
     * @param {number} nextWidth
     * @param {number} nextHeight
     */
    resize(nextWidth, nextHeight) {
      if (disposed) return;
      const validWidth = number(nextWidth, 1, 1, 8192);
      const validHeight = number(nextHeight, 1, 1, 8192);
      width = validWidth;
      height = validHeight;
      renderer.setSize(width, height, false);
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('click', click);
      for (const entry of entries.values()) release(entry);
      entries.clear();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  });
};
harden(makeThreeScene);
