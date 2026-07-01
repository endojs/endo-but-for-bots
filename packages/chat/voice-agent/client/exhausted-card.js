import { h } from 'preact';

// ── ExhaustedCard island — the prepaid-allowance wall: a conversation ran out of inference budget. No
// model produced this — it's a DETERMINISTIC gate. The owner (root) comps a free top-up; an invitee pays.
//
// Props: { isRoot, invited?, note? } + handlers { onTopUp(), onAbandon() }
// `invited` = this user's credit came CARRIED ON AN INVITE (a conserved allowance the inviter funded) —
// say so, and make "buy your own" the legible next step. Copy mirrors app.js renderExhausted exactly.
export const ExhaustedCard = (props = {}) => {
  const { isRoot = false, invited = false, note = '', onTopUp, onAbandon } = props;
  const blurb = isRoot
    ? 'This conversation has used up its budget. Top it up to keep going, or abandon the thread.'
    : invited
      ? 'The usage credit that came with your invite is used up. From here you buy your own — top up below and your stalled message resumes automatically.'
      : "You've used up the credit you were given. Add more to keep going — or abandon the thread.";
  const title = isRoot ? 'Out of inference allowance' : 'Allowance exhausted — top up to continue';
  return h('div', { class: 'prop msg exhausted-card' }, [
    h('div', { class: 'ptitle' }, ['🪙 ', h('span', null, title)]),
    h('div', { class: 'pmeta' }, blurb),
    h('div', { class: 'pbtns' }, [
      h('button', { class: 'confirm', onClick: () => onTopUp && onTopUp() }, isRoot ? 'Top up $0.50 & continue' : 'Add $5 credit'),
      h('button', { class: 'reject', onClick: () => onAbandon && onAbandon() }, 'Abandon thread'),
      note ? h('span', { class: 'pmeta', style: 'font-size:12px' }, note) : null,
    ]),
  ]);
};
