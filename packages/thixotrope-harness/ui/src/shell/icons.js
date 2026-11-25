// @ts-check
/**
 * Small inline-SVG icons for the shell's buttons, drawn on a 24-unit grid
 * in the current text colour (stroke 2, round ends), so a button's
 * `color` and hover rules colour them. Each icon is decorative
 * (`aria-hidden`, not focusable): the button that holds it carries the
 * accessible name in its `aria-label`.
 *
 * Used by the session sidebar (new, rename, delete, confirm, cancel); send,
 * stop, microphone, speaker and settings are here for the compose bar and
 * the header to adopt.
 */
import { h } from 'preact';

/**
 * The shapes of each icon: `[tag, attributes]` pairs inside the 24x24
 * view box.
 *
 * @type {Readonly<Record<string, ReadonlyArray<readonly [string, Record<string, string | number>]>>>}
 */
const shapes = harden({
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  pencil: [
    ['path', { d: 'M4 20l1-4L16 5l3 3L8 19z' }],
    ['path', { d: 'M14 7l3 3' }],
  ],
  trash: [
    ['path', { d: 'M4 7h16M9 7V4h6v3' }],
    ['path', { d: 'M6 7l1 13h10l1-13' }],
    ['path', { d: 'M10 11v5M14 11v5' }],
  ],
  check: [['path', { d: 'M5 12l5 5 9-10' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  send: [['path', { d: 'M12 19V5M5 12l7-7 7 7' }]],
  stop: [
    [
      'rect',
      { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' },
    ],
  ],
  microphone: [
    ['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }],
    ['path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }],
  ],
  speaker: [
    ['path', { d: 'M4 9v6h4l5 4V5L8 9z' }],
    ['path', { d: 'M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11' }],
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['circle', { cx: 12, cy: 12, r: 7 }],
    [
      'path',
      {
        d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
      },
    ],
  ],
});

/** The names `icon` accepts. */
export const iconNames = harden(Object.keys(shapes));
harden(iconNames);

/**
 * An icon as a Preact element: `<svg class="thix-icon thix-icon-<name>">`,
 * `size` pixels square unless CSS sizes it (`.floot-send svg` does).
 *
 * @param {string} name one of `iconNames`
 * @param {number} [size]
 */
export const icon = (name, size = 16) => {
  const parts = shapes[name];
  if (!parts) throw Error(`no icon named ${name}`);
  return h(
    'svg',
    {
      class: `thix-icon thix-icon-${name}`,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    parts.map(([tag, attributes]) => h(tag, { ...attributes })),
  );
};
harden(icon);
