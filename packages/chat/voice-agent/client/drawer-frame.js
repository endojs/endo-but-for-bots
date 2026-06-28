import { h, Fragment } from 'preact';

// ── DrawerFrame island (P4 shell→island migration) — the sidebar/drawer frame: the "Chats" head (+ New /
// close), the #chat-list mount point (app.js fills it imperatively — it is NOT a nested island), and the
// Settings footer. Renders the structure (every id/class); app.js wires new-chat / drawer-close / drawer-foot
// by id and renders the chat list into #chat-list after mount. Keep ids + #chat-list EXACTLY.
export const DrawerFrame = () => h(Fragment, {}, [
  h('div', { class: 'drawer-head' }, [
    h('b', {}, 'Chats'),
    h('span', { style: 'display:flex;gap:6px;align-items:center' }, [
      h('button', { class: 'mini', id: 'new-chat' }, '+ New'),
      h('button', { class: 'iconbtn', id: 'drawer-close', title: 'Close', style: 'font-size:18px;padding:0 4px' }, '✕'),
    ]),
  ]),
  h('div', { id: 'chat-list' }),
  h('button', { id: 'drawer-foot', class: 'drawer-foot', title: 'Global settings' }, [
    h('span', { class: 'df-ic' }, '⚙'),
    h('span', { class: 'df-main' }, [h('span', { class: 'df-title' }, 'Settings'), h('span', { class: 'df-sub', id: 'df-sub' }, 'Agent C')]),
    h('span', { class: 'df-chev' }, '›'),
  ]),
]);
