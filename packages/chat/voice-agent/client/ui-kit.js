import { h } from 'preact';

// ── ui-kit: the shared confined-Preact primitives every island builds on ─────────────────────────
// Pure (props)=>vnode building blocks. They render through renderConfined into the main page DOM, so
// they reuse the app's CSS classes (.ncard/.notif/.pill/.mini/.ntitle/.nbody/.nmeta/.sub) and theme
// automatically via its CSS vars (--bg/--ink/--acc/--edge/--panel/--mut). The point: factor our UI onto
// ONE small, well-tested kit so apps-within-apps share a consistent look + behavior. No state, no DOM,
// no caps — only render-safe props + callbacks. (Plain client style, like shares-panel.js: no harden.)

const str = v => (v == null ? '' : String(v));
// place a separator between items (strings or vnodes); drops null/'' items first.
const joinWith = (items, sep) => {
  const xs = items.filter(x => x != null && x !== '');
  return xs.flatMap((x, i) => (i === 0 ? [x] : [sep, x]));
};
export const joinDot = items => joinWith(items, ' · ');

// Chip — a small labeled badge. kind: '' | 'bad' | 'good' (maps to the .pill[.bad/.good] classes).
export const Chip = ({ label, kind = '', title } = {}) =>
  h('span', { class: `pill${kind ? ` ${kind}` : ''}`, title: title || undefined }, str(label));

// Btn — a kit button. variant '' | 'bad' | 'primary'; disabled supported; onClick gets the SafeEvent.
export const Btn = ({ label, onClick, variant = '', disabled = false, title } = {}) =>
  h('button', {
    class: `mini${variant ? ` ${variant}` : ''}`, disabled: disabled || undefined, title: title || undefined,
    onClick: disabled ? undefined : e => onClick && onClick(e),
  }, str(label));

// EmptyState — a muted placeholder for an empty list.
export const EmptyState = ({ text = 'nothing here' } = {}) => h('div', { class: 'pill' }, str(text));

// Meta — a "·"-joined row of small bits (strings or vnodes) with an optional right-aligned slot.
export const Meta = ({ parts = [], right = null } = {}) =>
  h('div', { class: 'nmeta' }, [h('span', null, joinDot(parts)), right || null]);

// Card — the standard island card shell: title (+ optional time), body, footer. attention adds .att;
// accent draws a left border (e.g. a per-agent security frame). cls overrides the shell class so the
// same structure can wear .notif (feed) or .ncard (generic) and stay visually consistent.
export const Card = ({ title, time, body, footer, attention = false, accent = '', cls = 'ncard', onClick } = {}) =>
  h('div', {
    class: `${cls}${attention ? ' att' : ''}${onClick ? ' card-open' : ''}`,
    style: accent ? `border-left:3px solid ${accent}` : undefined,
    onClick: onClick || undefined,
  }, [
    (title != null || (time != null && time !== '')) ? h('div', { class: 'ntitle' }, [
      h('span', null, str(title)),
      (time != null && time !== '') ? h('span', { class: 'ntime' }, str(time)) : null,
    ]) : null,
    (body != null && body !== '') ? h('div', { class: 'nbody' }, body) : null,
    footer != null ? h('div', { class: 'nmeta' }, footer) : null,
  ]);

// IconBtn — a compact icon/glyph button (e.g. ↻ ✎ ×).
export const IconBtn = ({ glyph, onClick, title, disabled = false } = {}) =>
  h('button', { class: 'kit-iconbtn', title: title || undefined, disabled: disabled || undefined, onClick: disabled ? undefined : e => onClick && onClick(e) }, str(glyph));

// Badge — a tiny count/status badge. kind: '' | 'bad' | 'mut'.
export const Badge = ({ label, kind = '' } = {}) => h('span', { class: `kit-badge${kind ? ` ${kind}` : ''}` }, str(label));

// Spinner — an indeterminate loading indicator.
export const Spinner = ({ label } = {}) => h('span', { class: 'kit-rowx' }, [h('span', { class: 'kit-spinner' }), label ? h('span', { class: 'sub' }, str(label)) : null]);

// Avatar — a circular initial/emoji avatar.
export const Avatar = ({ label = '?' } = {}) => h('span', { class: 'kit-avatar' }, String(label).slice(0, 2));

// ProgressBar — a 0..1 (or 0..100) determinate bar.
export const ProgressBar = ({ value = 0, max = 1 } = {}) => {
  const pct = Math.max(0, Math.min(100, (Number(value) / (Number(max) || 1)) * 100));
  return h('div', { class: 'kit-progress' }, h('span', { style: `width:${pct}%` }));
};

// Banner — an inline alert. kind: 'info' | 'warn' | 'error' | 'success'.
export const Banner = ({ kind = 'info', icon, children } = {}) =>
  h('div', { class: `kit-banner ${kind}` }, [icon ? h('span', null, str(icon)) : null, h('span', null, children)]);

// Divider — a horizontal rule.
export const Divider = () => h('hr', { class: 'kit-divider' });

// Stack / Row — the two basic layout primitives.
export const Stack = ({ children } = {}) => h('div', { class: 'kit-stack' }, children);
export const Row = ({ children } = {}) => h('div', { class: 'kit-rowx' }, children);

// Field — a labeled wrapper around any control (label + control + optional hint).
export const Field = ({ label, hint, control } = {}) =>
  h('div', { class: 'kit-field' }, [label != null ? h('span', { class: 'kit-label' }, str(label)) : null, control, hint ? h('span', { class: 'sub', style: 'font-size:11px' }, str(hint)) : null]);

// ── form inputs — CONTROLLED: value in, onInput/onChange(value) out (state lives in the host/cell). ──
export const TextField = ({ value = '', placeholder = '', type = 'text', onInput, onEnter, disabled = false } = {}) =>
  h('input', {
    class: 'kit-in', type, value, placeholder, disabled: disabled || undefined,
    onInput: e => onInput && onInput(e.target.value),
    onKeyDown: onEnter ? e => { if (e.key === 'Enter') onEnter(e.target.value); } : undefined,
  });

export const Textarea = ({ value = '', placeholder = '', rows = 3, onInput, disabled = false } = {}) =>
  h('textarea', { class: 'kit-in', rows, placeholder, disabled: disabled || undefined, onInput: e => onInput && onInput(e.target.value) }, str(value));

export const Select = ({ value = '', options = [], onChange, disabled = false } = {}) =>
  h('select', { class: 'kit-in', disabled: disabled || undefined, onChange: e => onChange && onChange(e.target.value) },
    (options || []).map((o, i) => {
      const val = o && typeof o === 'object' ? o.value : o;
      const label = o && typeof o === 'object' ? o.label : o;
      return h('option', { value: val, selected: String(val) === String(value), key: i }, str(label));
    }));

export const Checkbox = ({ label = '', checked = false, onChange, disabled = false } = {}) =>
  h('label', { class: 'kit-check' }, [
    h('input', { type: 'checkbox', checked: !!checked, disabled: disabled || undefined, onChange: e => onChange && onChange(!!e.target.checked) }),
    h('span', null, str(label)),
  ]);

export const Radio = ({ label = '', name, value, checked = false, onChange, disabled = false } = {}) =>
  h('label', { class: 'kit-check' }, [
    h('input', { type: 'radio', name, value, checked: !!checked, disabled: disabled || undefined, onChange: () => onChange && onChange(value) }),
    h('span', null, str(label)),
  ]);

// RadioGroup — a set of radios sharing a name; value is the selected option; onChange(value).
export const RadioGroup = ({ name = 'rg', value, options = [], onChange, inline = false } = {}) =>
  h('div', { class: inline ? 'kit-rowx' : 'kit-stack' }, (options || []).map((o, i) => {
    const val = o && typeof o === 'object' ? o.value : o;
    const label = o && typeof o === 'object' ? o.label : o;
    return Radio({ key: i, name, value: val, label, checked: String(val) === String(value), onChange });
  }));

// Toggle — an on/off switch.
export const Toggle = ({ label = '', checked = false, onChange, disabled = false } = {}) =>
  h('label', { class: 'kit-toggle' }, [
    h('input', { type: 'checkbox', checked: !!checked, disabled: disabled || undefined, onChange: e => onChange && onChange(!!e.target.checked) }),
    h('span', { class: 'kit-toggle-track' }, h('span', { class: 'kit-toggle-thumb' })),
    label ? h('span', null, str(label)) : null,
  ]);

// Tabs — a tab bar. tabs:[{id,label}], active id, onSelect(id).
export const Tabs = ({ tabs = [], active, onSelect } = {}) =>
  h('div', { class: 'kit-tabs' }, (tabs || []).map((t, i) =>
    h('button', { class: `kit-tab${String(t.id) === String(active) ? ' on' : ''}`, key: t.id || i, onClick: () => onSelect && onSelect(t.id) }, str(t.label))));

// SegmentedControl — a pill-style single-choice. options:[{value,label}]|[string], value, onChange(value).
export const SegmentedControl = ({ value, options = [], onChange } = {}) =>
  h('div', { class: 'kit-seg' }, (options || []).map((o, i) => {
    const val = o && typeof o === 'object' ? o.value : o;
    const label = o && typeof o === 'object' ? o.label : o;
    return h('button', { class: String(val) === String(value) ? 'on' : '', key: i, onClick: () => onChange && onChange(val) }, str(label));
  }));

// Slider — a range input. value/min/max/step; onInput(number).
export const Slider = ({ value = 0, min = 0, max = 100, step = 1, onInput, disabled = false } = {}) =>
  h('input', { class: 'kit-slider', type: 'range', value, min, max, step, disabled: disabled || undefined, onInput: e => onInput && onInput(Number(e.target.value)) });

// Skeleton — a shimmering loading placeholder.
export const Skeleton = ({ width = '100%', height = 14 } = {}) =>
  h('span', { class: 'kit-skel', style: `width:${typeof width === 'number' ? `${width}px` : width};height:${typeof height === 'number' ? `${height}px` : height}` });

// Disclosure — a collapsible section. open in props (stateless); onToggle().
export const Disclosure = ({ summary, open = false, children, onToggle } = {}) =>
  h('div', { class: 'kit-disc' }, [
    h('div', { class: 'kit-disc-head', onClick: () => onToggle && onToggle() }, [h('span', { class: 'caret' }, open ? '▾' : '▸'), str(summary)]),
    open ? h('div', null, children) : null,
  ]);

// Breadcrumb — a path of crumbs. items:[{label, onClick?}]; the last is the current (not a link).
export const Breadcrumb = ({ items = [] } = {}) =>
  h('div', { class: 'kit-crumbs' }, (items || []).flatMap((it, i) => {
    const last = i === items.length - 1;
    const crumb = (last || !it.onClick)
      ? h('span', { key: `c${i}` }, str(it.label))
      : h('a', { key: `c${i}`, onClick: () => it.onClick() }, str(it.label));
    return i === 0 ? [crumb] : [h('span', { class: 'sep', key: `s${i}` }, '›'), crumb];
  }));

// Modal — a centered dialog over a backdrop. open in props (stateless); onClose(). Renders null when closed.
export const Modal = ({ open = false, title, children, onClose } = {}) => {
  if (!open) return null;
  return h('div', { class: 'kit-modal-bg' },
    h('div', { class: 'kit-modal' }, [
      (title != null || onClose) ? h('div', { class: 'kit-modal-title' }, [h('span', null, str(title)), onClose ? h('button', { class: 'kit-modal-x', title: 'close', onClick: () => onClose() }, '×') : null]) : null,
      h('div', null, children),
    ]));
};

// Tooltip — a hover tooltip (CSS-driven) wrapping its children.
export const Tooltip = ({ tip, children } = {}) => h('span', { class: 'kit-tip' }, [children, h('span', { class: 'kit-tip-pop' }, str(tip))]);

// Menu — a dropdown. label, open (stateless), items:[{label,value}], onToggle(), onSelect(value).
export const Menu = ({ label = '⋯', open = false, items = [], onToggle, onSelect } = {}) =>
  h('span', { class: 'kit-menu' }, [
    h('button', { class: 'mini', onClick: () => onToggle && onToggle() }, str(label)),
    open ? h('div', { class: 'kit-menu-pop' }, (items || []).map((it, i) =>
      h('button', { class: 'kit-menu-item', key: i, onClick: () => onSelect && onSelect(it && it.value != null ? it.value : (it && it.label != null ? it.label : it)) }, str(it && it.label != null ? it.label : it)))) : null,
  ]);

// Toast — a transient notification. kind: ''|'error'|'success'; icon, message, onClose?.
export const Toast = ({ kind = '', icon, message, onClose } = {}) =>
  h('div', { class: `kit-toast${kind ? ` ${kind}` : ''}` }, [icon ? h('span', null, str(icon)) : null, h('span', null, str(message)), onClose ? h('button', { class: 'kit-iconbtn', onClick: () => onClose() }, '×') : null]);

// Pagination — 1-based page nav. page, pages (total), onPage(n).
export const Pagination = ({ page = 1, pages = 1, onPage } = {}) => {
  const nums = []; for (let i = 1; i <= pages; i += 1) nums.push(i);
  return h('div', { class: 'kit-page' }, [
    h('button', { disabled: page <= 1 || undefined, onClick: () => page > 1 && onPage && onPage(page - 1) }, '‹'),
    ...nums.map(n => h('button', { key: n, class: n === page ? 'on' : '', onClick: () => onPage && onPage(n) }, String(n))),
    h('button', { disabled: page >= pages || undefined, onClick: () => page < pages && onPage && onPage(page + 1) }, '›'),
  ]);
};

// Table — columns:[{key,label}], rows:[{...}] (div-based, render-safe cells).
export const Table = ({ columns = [], rows = [] } = {}) =>
  h('div', { class: 'kit-table' }, [
    h('div', { class: 'tr' }, columns.map((c, i) => h('div', { class: 'th', key: i }, str(c.label != null ? c.label : c.key)))),
    ...rows.map((r, ri) => h('div', { class: 'tr', key: ri }, columns.map((c, ci) => h('div', { class: 'td', key: ci }, str(r[c.key]))))),
  ]);

// Drawer — a side panel over a backdrop. open in props (stateless); onClose(). Null when closed.
export const Drawer = ({ open = false, title, children, onClose } = {}) => {
  if (!open) return null;
  return h('div', null, [
    h('div', { class: 'kit-drawer-bg', onClick: () => onClose && onClose() }),
    h('div', { class: 'kit-drawer' }, [
      (title != null || onClose) ? h('div', { class: 'kit-modal-title' }, [h('span', null, str(title)), onClose ? h('button', { class: 'kit-modal-x', title: 'close', onClick: () => onClose() }, '×') : null]) : null,
      h('div', null, children),
    ]),
  ]);
};

// Stepper — a horizontal step indicator. steps:[{label}]|[string], active index (0-based).
export const Stepper = ({ steps = [], active = 0 } = {}) =>
  h('div', { class: 'kit-stepper' }, (steps || []).flatMap((s, i) => {
    const cls = i < active ? 'kit-step done' : i === active ? 'kit-step on' : 'kit-step';
    const label = s && typeof s === 'object' ? s.label : s;
    const step = h('span', { class: cls, key: `s${i}` }, [h('span', { class: 'dot' }, i < active ? '✓' : String(i + 1)), h('span', null, str(label))]);
    return i === 0 ? [step] : [h('span', { class: 'kit-step-sep', key: `sep${i}` }), step];
  }));

// List — items:[{label, sub?, icon?}], onSelect?(index).
export const List = ({ items = [], onSelect } = {}) =>
  h('div', { class: 'kit-list' }, (items || []).map((it, i) =>
    h('div', { class: `kit-list-item${onSelect ? ' click' : ''}`, key: i, onClick: onSelect ? () => onSelect(i) : undefined }, [
      it.icon ? h('span', null, str(it.icon)) : null,
      h('div', { style: 'flex:1;min-width:0' }, [h('div', null, str(it.label)), it.sub ? h('div', { class: 'sub', style: 'font-size:11px' }, str(it.sub)) : null]),
    ])));
