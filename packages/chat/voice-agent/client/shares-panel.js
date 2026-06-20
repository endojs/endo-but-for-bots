import { h } from 'preact';

// The Shares panel island. Two sections: power INVITE links, and shared COMPONENTS (custom tools shared
// as a factory or an attenuated/metered/priced instance). Confined + cap-hygienic by construction: it
// is handed only render-safe data (labels, tags, modes, prices, counts) + index-based callbacks — never
// a swissnum or a share token (those stay in app.js's closure and are used only inside the callbacks).
//
// Props: {
//   items:      [{ label, tag }],                                   // power invites
//   components: [{ toolName, mode, price, used, atten, revoked }],  // shared components
//   earned:     string,                                            // sharer earnings, render-safe
//   onCopy(i), onQr(i), onRevoke(i),                               // invite handlers
//   onCopyComp(i), onRevokeComp(i),                                // component-share handlers
// }
const inviteRow = (s, i, { onCopy, onQr, onRevoke }) =>
  h('div', { class: 'share', key: `inv${i}` }, [
    h('div', null, [h('b', null, s.label || ''), ' ', h('span', { class: 'pill' }, s.tag || '')]),
    h('div', null, [
      h('button', { class: 'mini', onClick: () => onCopy && onCopy(i) }, 'copy link'), ' ',
      h('button', { class: 'mini', onClick: () => onQr && onQr(i) }, 'QR'), ' ',
      h('button', { class: 'mini bad', onClick: () => onRevoke && onRevoke(i) }, 'revoke'),
    ]),
  ]);

const compRow = (c, i, { onCopyComp, onRevokeComp }) =>
  h('div', { class: 'share', key: `cmp${i}` }, [
    h('div', null, [
      h('b', null, c.toolName || '(tool)'), ' ',
      h('span', { class: 'pill' }, `${c.mode}${c.price ? ` · ${c.price}` : ' · free'}${c.revoked ? ' · revoked' : ''}`),
    ]),
    h('div', { class: 'sub' }, `used ${c.used || 0}×${c.atten ? ` · ${c.atten}` : ''}`),
    c.revoked ? null : h('div', null, [
      h('button', { class: 'mini', onClick: () => onCopyComp && onCopyComp(i) }, 'copy link'), ' ',
      h('button', { class: 'mini bad', onClick: () => onRevokeComp && onRevokeComp(i) }, 'revoke'),
    ]),
  ]);

export const SharesPanel = (props = {}) => {
  const { items = [], components = [], earned = '', onCopy, onQr, onRevoke, onCopyComp, onRevokeComp } = props;
  const kids = [];
  kids.push(items.length ? h('div', null, items.map((s, i) => inviteRow(s, i, { onCopy, onQr, onRevoke }))) : h('div', { class: 'pill' }, 'no active invite links'));
  if (components.length) {
    kids.push(h('div', { class: 'shares-sec' }, `Shared components${earned ? ` · earned ${earned}` : ''}`));
    kids.push(h('div', null, components.map((c, i) => compRow(c, i, { onCopyComp, onRevokeComp }))));
  }
  return h('div', null, kids);
};
