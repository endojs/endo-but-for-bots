// @ts-check

import harden from '@endo/harden';
import { confineComponent } from '@endo/preact-container/compartment';
import { h } from 'preact';
import { useErrorBoundary, useMemo, useState } from 'preact/hooks';

/** @import { ComponentChildren } from 'preact' */

// Deliberately no resource-loading, navigation, forms, SVG, styles, classes,
// ids, or host callbacks. The generic confined renderer also strips refs and
// turns browser events into SafeEvents. This narrower profile closes its
// documented CSS/URL ambient-authority gaps for agent-authored widgets.
const TAGS = harden(
  new Set([
    'div',
    'span',
    'p',
    'strong',
    'em',
    'small',
    'br',
    'hr',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'button',
    'label',
    'input',
    'select',
    'option',
    'textarea',
    'output',
    'progress',
    'meter',
    'pre',
    'code',
  ]),
);
const ATTRS = harden(
  new Set([
    'title',
    'value',
    'checked',
    'disabled',
    'min',
    'max',
    'step',
    'placeholder',
    'rows',
    'cols',
    'multiple',
    'selected',
    'aria-label',
    'aria-pressed',
    'aria-expanded',
    'aria-valuetext',
  ]),
);
const EVENTS = harden(new Set(['onClick', 'onInput', 'onChange', 'onKeyDown']));
const INPUT_TYPES = harden(
  new Set([
    'text',
    'number',
    'range',
    'checkbox',
    'radio',
    'date',
    'time',
    'color',
  ]),
);

/**
 * Copy the guest's entire output, including hand-built nodes. Checking only h()
 * would let forged vnodes bypass the profile. One budget covers the whole tree.
 * @param {unknown} value
 * @param {(error: unknown) => void} onError
 * @returns {ComponentChildren}
 */
const widgetTree = (value, onError) => {
  let remaining = 2048;
  /**
   * @param {any} node
   * @param {number} [depth]
   * @returns {ComponentChildren}
   */
  const copy = (node, depth = 0) => {
    remaining -= 1;
    if (remaining < 0 || depth > 32) throw Error('Widget is too large');
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node === 'string') return node.slice(0, 16_384);
    if (typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(child => copy(child, depth + 1));
    if (typeof node !== 'object') return null;
    const { type, props: supplied } = node;
    if (typeof type !== 'string' || !TAGS.has(type)) return null;
    const props = supplied && typeof supplied === 'object' ? supplied : {};
    /** @type {Record<string, any>} */
    const safe = {};
    for (const name of ATTRS) {
      const v = props[name];
      if (typeof v === 'string') safe[name] = v.slice(0, 4096);
      else if (typeof v === 'number' || typeof v === 'boolean') safe[name] = v;
    }
    for (const name of EVENTS) {
      const callback = props[name];
      // eslint-disable-next-line no-continue
      if (typeof callback !== 'function') continue;
      safe[name] = (/** @type {unknown} */ event) => {
        try {
          // The renderer wraps this callback; event is a SafeEvent, never DOM.
          Promise.resolve(callback(event)).catch(onError);
        } catch (error) {
          onError(error);
        }
      };
    }
    if (type === 'button') safe.type = 'button';
    if (type === 'input')
      safe.type = INPUT_TYPES.has(props.type) ? props.type : 'text';
    const key = node.key;
    if (typeof key === 'string' || typeof key === 'number') safe.key = key;
    return h(type, safe, copy(props.children, depth + 1));
  };
  return copy(value);
};

/** @param {{source: string}} props */
const WidgetInstance = ({ source }) => {
  const [failed, setFailed] = useState(false);
  const [renderError] = useErrorBoundary(() => setFailed(true));
  const Guest = useMemo(() => {
    if (source.length > 65_536) return null;
    try {
      // Fail closed outside the locked-down browser. No global endowments,
      // module imports, DOM, fetch, timers, storage, or daemon references.
      const WidgetCompartment =
        /** @type {{ Compartment?: new () => { evaluate: (source: string) => unknown } }} */ (
          globalThis
        ).Compartment;
      if (
        typeof WidgetCompartment !== 'function' ||
        typeof globalThis.harden !== 'function' ||
        !Object.isFrozen(Object.prototype)
      )
        return null;
      const fn = new WidgetCompartment().evaluate(`(${source}\n)`);
      if (typeof fn !== 'function') return null;
      const onError = () => setFailed(true);
      return confineComponent(
        endowments => {
          const {
            h: create,
            useState: state,
            useReducer: reducerHook,
            useMemo: memo,
            useCallback,
          } = /** @type {any} */ (endowments);
          // Preact invokes hookState._reducer(state, action). A raw guest
          // reducer would receive hookState as `this`, including its component
          // and DOM pointers. Always enter guest callbacks with no receiver.
          const useReducer = (reducer, initial, init) =>
            reducerHook(
              (stateValue, action) =>
                Reflect.apply(reducer, undefined, [stateValue, action]),
              initial,
              init === undefined
                ? undefined
                : value => Reflect.apply(init, undefined, [value]),
            );
          const api = harden({
            h: create,
            useState: state,
            useReducer,
            useMemo: memo,
            useCallback,
          });
          return widgetTree(fn(api), onError);
        },
        { name: 'AgentWidget', onError },
      );
    } catch {
      return null;
    }
  }, [source]);
  return h(
    'section',
    {
      class: 'endo-interactive-widget',
      'aria-label': 'Interactive widget',
      // Host-owned style: guest content cannot cover app chrome.
      style: {
        contain: 'content',
        isolation: 'isolate',
        overflow: 'auto',
        maxHeight: '32rem',
        whiteSpace: 'normal',
        border: '1px solid currentColor',
        borderRadius: '8px',
        padding: '12px',
        margin: '8px 0',
      },
    },
    h('small', null, 'Interactive widget'),
    failed || renderError || !Guest
      ? h('p', { role: 'status' }, 'This widget could not be displayed.')
      : h(Guest, null),
  );
};

/**
 * A source change tears down all hooks and the previous Compartment.
 * @param {{source: string}} props
 */
export const InteractiveWidget = ({ source }) =>
  h(WidgetInstance, { key: source, source });
harden(InteractiveWidget);

/**
 * Preserve text exactly while recognizing only complete, top-level designated
 * fences. Other code fences are opaque, so examples cannot execute nested code.
 * Streaming Floot text never calls this function.
 * @param {string} text
 * @returns {Array<{text?: string, source?: string}>}
 */
export const widgetMessageParts = text => {
  const lines = text.split('\n');
  /** @type {Array<{text?: string, source?: string}>} */
  const parts = [];
  let plain = '';
  for (let i = 0; i < lines.length; i += 1) {
    const opening = /^(`{3,}|~{3,})(\w*)$/.exec(lines[i]);
    if (!opening) {
      plain += `${lines[i]}${i < lines.length - 1 ? '\n' : ''}`;
      // eslint-disable-next-line no-continue
      continue;
    }
    let end = i + 1;
    while (end < lines.length) {
      const closing = /^(`{3,}|~{3,})\s*$/.exec(lines[end]);
      if (
        closing &&
        closing[1][0] === opening[1][0] &&
        closing[1].length >= opening[1].length
      )
        break;
      end += 1;
    }
    if (opening[2] === 'endowidget' && end < lines.length) {
      if (plain) parts.push({ text: plain });
      plain = '';
      parts.push({ source: lines.slice(i + 1, end).join('\n') });
      if (end < lines.length - 1) plain = '\n';
    } else {
      plain += lines.slice(i, Math.min(end + 1, lines.length)).join('\n');
      if (end < lines.length - 1) plain += '\n';
    }
    i = end;
  }
  if (plain) parts.push({ text: plain });
  return parts;
};
harden(widgetMessageParts);
