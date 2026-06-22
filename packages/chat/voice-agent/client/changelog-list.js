import { h } from 'preact';
import { Btn, Chip, EmptyState } from './ui-kit.js';

// ── ChangelogList island — the 🔧 self-applied-changes log, factored onto the ui-kit ─────────────
// Render-safe rows describing auto-merged improvements; onRevert(id) runs the host-side revert
// (git revert -m 1 of the recorded merge commit). A reverted row shows a pill instead of the button.
//
// Props: {
//   merges: [{ id, goal, when, sha, rolledBack, revertedWhen }],
//   onRevert(id),
// }
const row = (m, i, onRevert) =>
  h('div', { class: 'ncard', key: m.id || i, style: 'display:flex;gap:8px;align-items:flex-start' }, [
    h('div', { style: 'flex:1;min-width:0' }, [
      h('div', { style: 'font-size:13px' }, m.goal || '(improvement)'),
      h('div', { class: 'sub', style: 'font-size:11px' },
        [m.when || '', m.sha ? ` · ${m.sha}` : '', m.rolledBack && m.revertedWhen ? ` · reverted ${m.revertedWhen}` : ''].join('')),
    ]),
    m.rolledBack
      ? Chip({ label: '↩ reverted' })
      : Btn({ label: '↩ Revert', onClick: () => onRevert && onRevert(m.id) }),
  ]);

export const ChangelogList = (props = {}) => {
  const { merges = [], onRevert } = props;
  if (!merges.length) return EmptyState({ text: 'no self-applied changes yet' });
  return h('div', null, merges.map((m, i) => row(m, i, onRevert)));
};
