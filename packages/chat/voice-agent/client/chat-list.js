import { h } from 'preact';
import { EmptyState } from './ui-kit.js';

// ── ChatList island — the recency-sorted sidebar list. The persistent search box + pagination state
// live in the HOST (an input must keep focus across re-renders); this island renders the ITEMS. Inline
// rename is STATELESS: the host holds editingId + draft, and the edited row shows an input (Enter commits,
// Esc/blur cancels) — preserving the double-click-to-rename UX. Render-safe items only; handlers by id.
//
// Props: { items:[{id,title,voice,perm:''|'write'|'read',needs,active}], more, editingId, draft, emptyText }
// Handlers: { onSelect(id), onDelete(id), onMore(), onRenameStart(id), onRenameChange(v), onRenameCommit(save) }
const permIcon = perm =>
  perm === 'write' ? h('span', { class: 'ci-perm', title: 'shared link · you can post' }, '✍️ ')
    : perm === 'read' ? h('span', { class: 'ci-perm', title: 'shared link · read-only' }, '🔒 ')
      : null;

const row = (it, p) => {
  const editing = it.id === p.editingId;
  const titleSpan = h('span', {
    class: 'ci-title', title: it.voice ? undefined : 'double-click to rename',
    onClick: () => p.onSelect && p.onSelect(it.id),
    onDblClick: it.voice ? undefined : e => { if (e && e.stopPropagation) e.stopPropagation(); p.onRenameStart && p.onRenameStart(it.id); },
  }, [
    it.needs ? h('span', { class: 'ci-dot', title: 'awaiting your reply' }) : null,
    permIcon(it.perm),
    it.voice ? '🎙 ' : '',
    it.title,
  ]);
  const editor = h('input', {
    class: 'kit-in', value: p.draft || '', autofocus: true,
    onInput: e => p.onRenameChange && p.onRenameChange(e.target.value),
    onKeyDown: e => { if (e.key === 'Enter') p.onRenameCommit && p.onRenameCommit(true); else if (e.key === 'Escape') p.onRenameCommit && p.onRenameCommit(false); },
    onBlur: () => p.onRenameCommit && p.onRenameCommit(false),
  });
  return h('div', { class: `chat-item${it.active ? ' on' : ''}`, key: it.id, 'data-id': it.id }, [
    editing ? editor : titleSpan,
    h('button', { class: 'ci-del mini', title: 'delete', onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); p.onDelete && p.onDelete(it.id); } }, '×'),
  ]);
};

export const ChatList = (props = {}) => {
  const { items = [], more = 0, emptyText = 'no chats', onMore } = props;
  if (!items.length) return EmptyState({ text: emptyText });
  return h('div', null, [
    ...items.map(it => row(it, props)),
    more > 0 ? h('button', { class: 'ci-more mini', style: 'width:100%;margin-top:4px;opacity:.85', onClick: () => onMore && onMore() }, `show ${more} more`) : null,
  ]);
};
