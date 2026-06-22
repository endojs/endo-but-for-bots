import { h } from 'preact';
import { Checkbox, Banner } from './ui-kit.js';

// ── ProposalCard island — the confirm/reject gatekeeper for a destructive action, factored onto the kit.
// Render-safe: `proposal.detail` carries plain data the body renders by type; `icon` + `accent` (the
// per-agent security frame colour) are pre-resolved by the host. Stateless: the "don't ask again" toggle
// lives in props (dontAsk) + onToggleDontAsk; confirm passes it. Keeps the prominent .confirm/.reject
// buttons for visual fidelity; warnings use the kit Banner.
//
// Props: { proposal:{id,type,title,detail,summary}, icon, accent, mayConfirm, dontAsk }
// Handlers: { onConfirm(id, dontAskAgain), onReject(id), onToggleDontAsk(checked) }
const kv = pairs => h('div', { class: 'kv' }, pairs.filter(p => p[1] != null && p[1] !== '').map(([k, v], i) => h('div', { key: i }, [h('b', null, k), String(v)])));
const diffBlock = (oldC, newC) => h('div', null, [
  oldC ? h('div', { class: 'diff', style: 'opacity:.55;text-decoration:line-through' }, oldC) : null,
  (newC != null && newC !== '') ? h('div', { class: 'diff' }, newC) : null,
]);
const warn = txt => Banner({ kind: 'warn', icon: '⚠️', children: txt });

const proposalBody = p => {
  const d = p.detail || {};
  switch (p.type) {
    case 'note-edit': return h('div', null, [h('div', { class: 'pmeta' }, `${d.path} · ${d.mode}`), diffBlock(d.oldContent, d.newContent)]);
    case 'system-prompt': return h('div', null, [h('div', { class: 'pmeta' }, "the agent's own system-prompt block"), diffBlock(d.oldContent, d.newContent)]);
    case 'home-assistant': return kv([['entity', d.entity_id], ['service', d.service], ['data', d.data && Object.keys(d.data).length ? JSON.stringify(d.data) : '']]);
    case 'email': return h('div', null, [kv([['to', d.to], ['subject', d.subject]]), h('div', { class: 'diff' }, d.body || ''), warn('Confirming sends this via your SMTP relay (or saves a reviewed draft if no relay creds are set).')]);
    case 'subagent': return h('div', null, [kv([['name', d.name], ['task', d.task], ['powers', (d.powers || []).join(', ') || '(none)']]), warn('Confirming queues it to the dashboard for a second approval before anything with system access runs.')]);
    case 'contact-add': case 'contact-edit': return h('div', null, [h('div', { class: 'pmeta' }, p.type === 'contact-edit' ? `edit ${d.handle}` : 'new contact'), kv([['name', d.name], ['email', d.email], ['phone', d.phone], ['org', d.org], ['note', d.note]])]);
    case 'spawn-specialist': return h('div', null, [h('div', { class: 'pmeta' }, d.domain || 'specialist'), kv([['name', d.name], ['powers', (d.powers || []).join(', ') || '(none)']]), d.instructions ? h('div', { class: 'diff' }, d.instructions) : null, warn('Confirming creates a persistent specialist with these powers. You will still confirm each destructive action until you grant it autonomy.')]);
    case 'give-kazputer': return h('div', null, [kv([['for', d.name], ['email', d.email]]), warn('Confirming creates a new Kazputer and emails the invite link.')]);
    case 'kazputer-setting': return kv([['setting', d.setting], ['value', String(d.value)]]);
    case 'kazputer-coins': return kv([['coins', `${Number(d.coins) >= 0 ? '+' : ''}${d.coins}`]]);
    default: return h('div', { class: 'kv' }, p.summary || '');
  }
};

export const ProposalCard = (props = {}) => {
  const { proposal = {}, icon = '⚠️', accent = '', mayConfirm = false, dontAsk = false, onConfirm, onReject, onToggleDontAsk } = props;
  const noDontAsk = ['home-assistant', 'spawn-specialist'].includes(proposal.type);
  return h('div', { class: 'prop msg', style: accent ? `border-left:3px solid ${accent}` : undefined }, [
    h('div', { class: 'ptitle' }, [`${icon} `, h('span', null, proposal.title || 'Proposed action')]),
    proposalBody(proposal),
    h('div', { class: 'pbtns' }, mayConfirm ? [
      h('button', { class: 'confirm', onClick: () => onConfirm && onConfirm(proposal.id, !noDontAsk && !!dontAsk) }, 'Confirm'),
      h('button', { class: 'reject', onClick: () => onReject && onReject(proposal.id) }, 'Reject'),
      noDontAsk ? null : Checkbox({ label: `don't ask again for ${proposal.type}`, checked: dontAsk, onChange: v => onToggleDontAsk && onToggleDontAsk(v) }),
    ] : [h('span', { class: 'pmeta' }, "awaiting the operator's confirmation")]),
  ]);
};
