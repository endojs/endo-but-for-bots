import { h } from 'preact';
import { Card, Btn, joinDot } from './ui-kit.js';

// ── NotificationCard island — one feed / inbox card, factored onto the ui-kit ────────────────────
// Cap-hygienic by construction: it is handed only RENDER-SAFE data. Links carry a LABEL + index, NEVER
// a URL or swissnum — clicking calls onOpenLink(i) so the host resolves + opens link i (where the real
// href/cap lives in app.js's closure). onDone(id) dismisses. Mirrors the look of the imperative
// notifCard() so it drops straight into the inbox.
//
// Props: {
//   id, title, time, body, agent, avatar, status,
//   links: [{ label }],            // render-safe; click → onOpenLink(index)
//   attention, withDone,
//   onDone(id), onOpenLink(index),
// }
export const NotificationCard = (props = {}) => {
  const {
    id, title = '', time = '', body = '', agent = '', avatar = '', status = '',
    links = [], attention = false, withDone = false, onDone, onOpenLink,
  } = props;
  const metaBits = [
    agent ? `${avatar ? `${avatar} ` : ''}${agent}` : '',
    status || '',
    ...links.map((l, i) => h('button', {
      class: 'nlink', key: `lnk${i}`, onClick: () => onOpenLink && onOpenLink(i),
    }, (l && l.label) || 'open')),
  ];
  const footer = [
    h('span', null, joinDot(metaBits)),
    withDone ? h('button', { class: 'ndone', onClick: () => onDone && onDone(id) }, 'Done') : null,
  ];
  return Card({ cls: 'notif', title, time, body, attention, footer });
};
