import { h } from 'preact';
import { Btn, Chip } from './ui-kit.js';

// ── ChatMetaBar island — the per-chat top bar. Two modes:
//   memo: 🎙 title + a version scrubber (◀ label k/n ▶) + "Re-run / change env"
//   chat: title + parent chip (↑ from) + project chip (📂) + share-rights badge (✍️/🔒)
// Render-safe scalars; handlers index back to the host.
//
// Props (memo): { mode:'memo', title, versionLabel, varIx, varCount } + { onVersionPrev, onVersionNext, onRerun }
// Props (chat): { mode:'chat', title, shareMode:''|'write'|'read', metered, parent:{id,title,available}, project:{id,name} }
//               + { onOpenParent(id), onOpenProject(id) }
export const ChatMetaBar = (props = {}) => {
  const { mode = 'chat', title = 'chat' } = props;
  if (mode === 'memo') {
    const { versionLabel = '', varIx = 0, varCount = 1, onVersionPrev, onVersionNext, onRerun } = props;
    const scrub = varCount > 1 ? h('span', { class: 'cb-scrub kit-rowx' }, [
      Btn({ label: '◀', disabled: varIx <= 0, onClick: () => onVersionPrev && onVersionPrev() }),
      h('b', null, versionLabel || `v${varIx}`),
      Chip({ label: `${varIx + 1}/${varCount}` }),
      Btn({ label: '▶', disabled: varIx >= varCount - 1, onClick: () => onVersionNext && onVersionNext() }),
    ]) : null;
    return h('div', { class: 'kit-rowx' }, [
      h('span', { class: 'cb-title' }, `🎙 ${title}`), scrub,
      h('span', { style: 'flex:1' }), Btn({ label: '↻ Re-run / change env', onClick: () => onRerun && onRerun() }),
    ]);
  }
  const { shareMode = '', metered = false, parent = null, project = null, onOpenParent, onOpenProject } = props;
  const parentChip = parent ? (parent.available
    ? h('button', { class: 'mini cb-parent', title: 'open the chat this was created from', onClick: () => onOpenParent && onOpenParent(parent.id) }, `↑ from: ${parent.title || 'parent chat'}`)
    : h('span', { class: 'mini', style: 'opacity:.6', title: 'the originating chat is no longer available' }, `↑ from: ${parent.title || 'parent chat'}`)) : null;
  const projChip = project ? h('button', { class: 'mini cb-proj', title: "open this project's shared files", onClick: () => onOpenProject && onOpenProject(project.id) }, `📂 ${project.name || 'project'}`) : null;
  const badge = shareMode === 'write' ? h('span', { class: 'cb-right write' }, `✍️ live room · you can post${metered ? ' · metered allowance' : ''}`)
    : shareMode === 'read' ? h('span', { class: 'cb-right ro' }, "🔒 live room · read-only — view, can't post") : null;
  return h('div', { class: 'kit-rowx' }, [h('span', { class: 'cb-title' }, title), parentChip, projChip, h('span', { style: 'flex:1' }), badge]);
};
