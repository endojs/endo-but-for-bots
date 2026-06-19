import { h } from 'preact';

// The first confined-Preact ISLAND: the Shares panel (active invite links).
//
// CONFINEMENT + CAP-HYGIENE BY CONSTRUCTION: this component receives ONLY render-safe data — a label
// and a display tag per row — plus index-based callbacks. It is NEVER handed a swissnum (the share's
// secret `swiss` stays in app.js's closure and is used only inside the callbacks). Rendered through
// `renderConfined`, it sees no live DOM and no real events (a frozen SafeEvent facade only), so even a
// future malicious version of this component has nothing to exfiltrate.
//
// Props: { items: [{ label, tag }], onCopy(i), onQr(i), onRevoke(i) }.
export const SharesPanel = ({ items = [], onCopy, onQr, onRevoke }) => {
  if (!items.length) {
    return h('div', { class: 'pill' }, 'no active invite links');
  }
  return h(
    'div',
    null,
    items.map((s, i) =>
      h('div', { class: 'share', key: i }, [
        h('div', null, [
          h('b', null, s.label || ''),
          ' ',
          h('span', { class: 'pill' }, s.tag || ''),
        ]),
        h('div', null, [
          h('button', { class: 'mini', onClick: () => onCopy && onCopy(i) }, 'copy link'),
          ' ',
          h('button', { class: 'mini', onClick: () => onQr && onQr(i) }, 'QR'),
          ' ',
          h('button', { class: 'mini bad', onClick: () => onRevoke && onRevoke(i) }, 'revoke'),
        ]),
      ]),
    ),
  );
};
