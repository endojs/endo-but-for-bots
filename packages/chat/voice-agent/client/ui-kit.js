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
export const Card = ({ title, time, body, footer, attention = false, accent = '', cls = 'ncard' } = {}) =>
  h('div', {
    class: `${cls}${attention ? ' att' : ''}`,
    style: accent ? `border-left:3px solid ${accent}` : undefined,
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
