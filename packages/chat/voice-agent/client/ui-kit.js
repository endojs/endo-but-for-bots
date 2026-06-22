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
