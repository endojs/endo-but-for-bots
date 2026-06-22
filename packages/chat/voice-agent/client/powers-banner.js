import { h } from 'preact';

// ── PowersBanner island — the "this chat can …" capability strip, factored onto the ui-kit's chip look ──
// Render-safe: each chip carries its power NAME + a pre-resolved icon + tooltip (the host resolves icons/
// tips). When `manageable`, each chip gets a × (onRevoke) and a trailing "+ Add" (onAddPowers). Reusable
// for ANY visualization of a cap's / invite's / delegate's granted ring.
//
// Props: { items:[{ power, icon, tip }], manageable, label } + handlers { onRevoke(power), onAddPowers() }
const chip = (it, i, { manageable, onRevoke }) =>
  h('span', { class: 'chip', title: it.tip || it.power, key: `pw${i}` }, [
    `${it.icon || '🔑'} ${it.power}`,
    manageable ? h('button', { class: 'chip-x', title: `revoke ${it.power}`, onClick: () => onRevoke && onRevoke(it.power) }, '×') : null,
  ]);

export const PowersBanner = (props = {}) => {
  const { items = [], manageable = false, label = '🔑 this chat can', onRevoke, onAddPowers } = props;
  return h('div', null, [
    h('span', { class: 'pb-label' }, label),
    ...items.map((it, i) => chip(it, i, { manageable, onRevoke })),
    manageable ? h('button', { class: 'chip chip-add', title: 'grant another power', onClick: () => onAddPowers && onAddPowers() }, '+ Add') : null,
  ]);
};
