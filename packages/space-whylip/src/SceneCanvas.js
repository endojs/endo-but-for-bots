// @ts-check

import { HostPassthrough } from '@endo/preact-container/renderer';
import { h } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import { makeSceneRuntime } from './scene-runtime.js';
import { makeThreeScene } from './three-scene.js';

/** @import { SceneProps } from './scene-runtime.js' */

/**
 * Only this trusted host component owns the canvas, WebGL context and refs.
 * The guest receives inert scene descriptions and frozen click coordinates.
 * @param {{ runtime: ReturnType<typeof makeSceneRuntime> }} props
 */
function ThreeSurface({ runtime }) {
  /** @type {import('preact').RefObject<HTMLCanvasElement>} */
  const canvas = useRef(null);
  /** @type {import('preact').RefObject<ReturnType<typeof makeThreeScene> | null>} */
  const controller = useRef(null);
  const interactive = useRef(false);
  const contextLost = useRef(false);
  /** @type {import('preact').RefObject<HTMLDivElement>} */
  const container = useRef(null);
  /** @type {import('preact').RefObject<HTMLParagraphElement>} */
  const fallback = useRef(null);
  /** @param {string} message */
  const showFailure = message => {
    interactive.current = false;
    if (fallback.current) {
      fallback.current.textContent = message;
      fallback.current.hidden = false;
    }
  };
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    let observer;
    const restored = () => {
      contextLost.current = false;
      const scene = runtime.getScene();
      if (!scene || !controller.current) return;
      try {
        controller.current.update(scene);
        interactive.current = true;
        if (fallback.current) fallback.current.hidden = true;
      } catch (_error) {
        showFailure(
          'The 3D view could not recover. You can still use the story controls.',
        );
      }
    };
    const lost = () => {
      contextLost.current = true;
      showFailure(
        'Restoring the 3D view. You can still use the story controls.',
      );
    };
    try {
      const surface = makeThreeScene(element, {
        onEvent: event => {
          if (interactive.current) runtime.dispatchSceneEvent(event);
        },
        pixelRatio: Math.max(
          0.5,
          Math.min(globalThis.devicePixelRatio || 1, 2),
        ),
      });
      controller.current = surface;
      element.addEventListener('webglcontextlost', lost);
      element.addEventListener('webglcontextrestored', restored);
      const resize = () => {
        const rect = element.getBoundingClientRect();
        try {
          surface.resize(
            Math.max(1, Math.min(8192, rect.width)),
            Math.max(1, Math.min(8192, rect.height)),
          );
        } catch (_error) {
          showFailure(
            'The 3D view could not resize. You can still use the story controls.',
          );
        }
      };
      observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();
    } catch (_error) {
      showFailure(
        'The 3D view could not start. You can still use the story controls.',
      );
    }
    return () => {
      observer?.disconnect();
      element.removeEventListener('webglcontextlost', lost);
      element.removeEventListener('webglcontextrestored', restored);
      controller.current?.dispose();
      controller.current = null;
      interactive.current = false;
    };
  }, [runtime]);
  useLayoutEffect(() => {
    const scene = runtime.getScene();
    if (container.current) container.current.hidden = !scene;
    if (scene && controller.current && !contextLost.current) {
      try {
        controller.current.update(scene);
        interactive.current = true;
        if (fallback.current) fallback.current.hidden = true;
      } catch (_error) {
        showFailure(
          'The 3D view could not update. You can still use the story controls.',
        );
      }
    }
  });
  return h(
    'div',
    { class: 'whylip-three-surface', ref: container },
    h('canvas', {
      ref: canvas,
      'aria-label': 'Interactive three-dimensional story scene',
    }),
    h('p', {
      class: 'whylip-three-fallback',
      role: 'status',
      ref: fallback,
      hidden: true,
    }),
  );
}

/**
 * A persistent scene inside the application's renderConfined tree. Source
 * changes replace the render implementation, never the component identity.
 * @param {SceneProps & { onError?: (error: string | null) => void }} props
 */
export function SceneCanvas({
  source,
  state,
  assets,
  onAction,
  onState,
  onError,
}) {
  const runtime = useMemo(() => makeSceneRuntime(), []);
  useLayoutEffect(() => {
    onError?.(runtime.getError());
  });
  return h(
    'div',
    { class: 'whylip-scene', 'aria-label': 'Interactive story' },
    h(
      'div',
      { class: 'whylip-scene-overlay' },
      h(runtime.Component, { source, state, assets, onAction, onState }),
    ),
    h(HostPassthrough, null, h(ThreeSurface, { runtime })),
  );
}
harden(SceneCanvas);
