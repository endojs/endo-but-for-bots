import { h } from 'preact';

// ── TraceSignature island — the inline reasoning-signature strip under an answer: a "⊿ trace · N" label
// (click to grow inline), a ⊿3D button (opens the 3D trace), and per-step glyph nodes. Render-safe: each
// step carries {name, icon, ok, childCount, detail, children?}. Stateless: `expanded` lives in the host.
//
// Props: { steps:[{name,icon,ok,childCount,detail,children}], expanded, legend } + { onToggle(), onOpen3D() }
const stepRow = (s, depth, key) => h('div', { class: 'trace-sig-row', style: `padding-left:${depth * 14}px`, key }, [
  h('span', { class: s.ok === false ? 'bad' : '', style: `font:600 12px ui-monospace,Menlo,monospace;color:${s.ok === false ? 'var(--trace-bad)' : 'var(--trace-ok)'}` }, `${s.icon || '⚙'} ${s.name}${s.ok === false ? '  ✗ failed' : ''}`),
  s.detail ? h('span', { class: 'sub', style: 'font-size:11px;margin-left:6px;color:var(--trace-call)' }, String(s.detail).slice(0, 200)) : null,
  ...(Array.isArray(s.children) ? s.children.map((c, i) => stepRow(c, depth + 1, `${key}-${i}`)) : []),
]);

export const TraceSignature = (props = {}) => {
  const { steps = [], expanded = false, legend = '', onToggle, onOpen3D } = props;
  const head = [
    h('span', { class: 'ts-label', style: 'cursor:pointer', title: legend, onClick: () => onToggle && onToggle() }, `⊿ trace · ${steps.length} ${expanded ? '▾' : '▸'}`),
    h('span', { class: 'tn', style: 'cursor:pointer', title: 'Open the 3D trace', onClick: () => onOpen3D && onOpen3D() }, '⊿3D'),
  ];
  if (!expanded) {
    steps.forEach((s, i) => head.push(h('span', {
      class: `tn${s.ok === false ? ' bad' : ''}`, key: `g${i}`,
      title: `${s.name}${s.ok === false ? ' (failed)' : ''}${s.detail ? ` — ${String(s.detail).slice(0, 200)}` : ''}`,
    }, `${s.icon || '⚙'} ${s.name}${s.childCount ? ` ·${s.childCount}` : ''}`)));
    return h('div', { class: 'trace-strip kit-rowx' }, head);
  }
  return h('div', { class: 'trace-strip kit-rowx' }, [
    ...head,
    h('div', { class: 'trace-sig', style: 'flex-basis:100%;width:100%;margin-top:6px;padding:8px 10px;background:var(--trace-bg);border:1px solid var(--trace-edge);border-radius:8px;max-height:44vh;overflow:auto' },
      steps.map((s, i) => stepRow(s, 0, `s${i}`))),
  ]);
};
