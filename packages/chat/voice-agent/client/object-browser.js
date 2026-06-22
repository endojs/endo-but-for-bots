import { h } from 'preact';
import { Breadcrumb, EmptyState, Btn } from './ui-kit.js';

// ── ObjectBrowser island — the capability navigator: a breadcrumb path + a filtered list of folders/
// leaves, each shareable (RO/full, or a single 🔗 share for granule namespaces). The filter input stays
// host-side (focus). Render-safe items; handlers index by position.
//
// Props: { crumbs:[{label}], items:[{label, sub, leaf, root}], roOnly, emptyText }
// Handlers: { onCrumb(index /* -1 = Home */), onDrill(index), onShareRO(index), onShareFull(index) }
const itemRow = (k, i, { roOnly, onDrill, onShareRO, onShareFull }) =>
  h('div', { class: 'share', key: i }, [
    h('div', null, [k.leaf ? '' : '📂 ', h('b', null, k.label), ' ', h('span', { class: 'pill' }, k.sub || '')]),
    h('div', { class: 'kit-rowx' }, [
      k.leaf ? null : Btn({ label: 'open', onClick: () => onDrill && onDrill(i) }),
      k.root ? null : (roOnly
        ? Btn({ label: '🔗 share', onClick: () => onShareRO && onShareRO(i) })
        : h('span', { class: 'kit-rowx' }, [Btn({ label: 'RO', onClick: () => onShareRO && onShareRO(i) }), Btn({ label: 'full', onClick: () => onShareFull && onShareFull(i) })])),
    ]),
  ]);

export const ObjectBrowser = (props = {}) => {
  const { crumbs = [], items = [], emptyText = '(nothing here)', onCrumb } = props;
  const crumbItems = [{ label: 'Home', onClick: () => onCrumb && onCrumb(-1) }, ...crumbs.map((c, i) => ({ label: c.label, onClick: () => onCrumb && onCrumb(i) }))];
  return h('div', null, [
    Breadcrumb({ items: crumbItems }),
    items.length ? h('div', null, items.map((k, i) => itemRow(k, i, props))) : EmptyState({ text: emptyText }),
  ]);
};
