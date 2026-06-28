import { h, Fragment } from 'preact';

// ── InboxView island (P4 shell→island migration) — the 🔔 Notifications view. A container whose section LISTS
// are filled after mount: att-list imperatively (innerHTML), rec-list + chg-list via NESTED islands
// (renderNotifications / renderChangelog → renderConfined). The container renders ONCE (no cells) so it never
// re-diffs the slots — the nested island renders coexist. Keep every id EXACTLY.
export const InboxView = () => h(Fragment, {}, [
  h('div', { style: 'font-size:15px;margin-bottom:6px' }, h('b', {}, '🔔 Notifications')),
  h('div', { class: 'sub', style: 'margin-bottom:6px' }, 'Action items your agents raised, plus recent activity — reused from your dashboard feed.'),
  h('div', { class: 'inbox-section' }, [
    h('div', { class: 'inbox-head', id: 'att-head' }, [h('span', { class: 'caret' }, '▾'), ' ⚡ Needs your attention ', h('span', { class: 'pill', id: 'att-count' })]),
    h('div', { id: 'att-list', class: 'inbox-list' }),
  ]),
  h('div', { class: 'inbox-section' }, [
    h('div', { class: 'inbox-head', id: 'rec-head' }, [h('span', { class: 'caret' }, '▸'), ' Recent activity']),
    h('div', { id: 'rec-list', class: 'inbox-list hide' }),
  ]),
  h('div', { class: 'inbox-section', id: 'chg-section' }, [
    h('div', { class: 'inbox-head', id: 'chg-head' }, [h('span', { class: 'caret' }, '▸'), ' 🔧 Self-applied changes ', h('span', { class: 'pill', id: 'chg-count' })]),
    h('div', { id: 'chg-list', class: 'inbox-list hide' }),
  ]),
]);
