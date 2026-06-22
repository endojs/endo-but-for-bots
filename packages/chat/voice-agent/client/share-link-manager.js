import { h } from 'preact';
import { Btn, TextField, Select, RadioGroup, Chip, EmptyState } from './ui-kit.js';

// ── ShareLinkManager island — manage a chat's share links: list each (name + mode + allowance) with
// copy/QR/adjust/revoke + an inline adjust form, and a create-new-link form. Tokens flow to handlers but
// are NEVER rendered as visible text (cap-hygiene). Stateless: `adjusting` + the drafts live in the host.
//
// Props: { title, links:[{token,name,mode,allowanceUsd,adjusting,draftName,draftMode,draftAllow}],
//          newName, newMode, newAllow }
// Handlers: { onCopy(token), onQr(token), onAdjustToggle(token), onAdjustField(token,field,value),
//             onSave(token), onRevoke(token), onNewField(field,value), onCreate() }
const modeBadge = m => (m === 'write' ? Chip({ label: '✍️ write' }) : Chip({ label: '🔒 read' }));

const linkRow = (s, p) => h('div', { class: 'share', style: 'flex-direction:column;align-items:stretch;gap:6px', key: s.token }, [
  h('div', { class: 'kit-rowx', style: 'justify-content:space-between' }, [
    h('span', null, [h('b', null, s.name || '(unnamed)'), ' ', modeBadge(s.mode), s.allowanceUsd ? h('span', null, [' ', Chip({ label: `$${s.allowanceUsd}` })]) : null]),
    h('span', { class: 'kit-rowx' }, [
      Btn({ label: 'copy', onClick: () => p.onCopy && p.onCopy(s.token) }),
      Btn({ label: 'QR', onClick: () => p.onQr && p.onQr(s.token) }),
      Btn({ label: 'adjust', onClick: () => p.onAdjustToggle && p.onAdjustToggle(s.token) }),
      Btn({ label: 'revoke', variant: 'bad', onClick: () => p.onRevoke && p.onRevoke(s.token) }),
    ]),
  ]),
  s.adjusting ? h('div', { class: 'kit-rowx', style: 'border-top:1px solid var(--edge);padding-top:6px;flex-wrap:wrap' }, [
    TextField({ value: s.draftName != null ? s.draftName : (s.name || ''), placeholder: 'name', onInput: v => p.onAdjustField && p.onAdjustField(s.token, 'name', v) }),
    Select({ value: s.draftMode || s.mode || 'read', options: [{ value: 'read', label: 'read-only' }, { value: 'write', label: 'write' }], onChange: v => p.onAdjustField && p.onAdjustField(s.token, 'mode', v) }),
    TextField({ type: 'number', value: s.draftAllow != null ? s.draftAllow : (s.allowanceUsd || ''), placeholder: '$0', onInput: v => p.onAdjustField && p.onAdjustField(s.token, 'allow', v) }),
    Btn({ label: 'save', variant: 'primary', onClick: () => p.onSave && p.onSave(s.token) }),
  ]) : null,
]);

export const ShareLinkManager = (props = {}) => {
  const { title = 'chat', links = [], newName = '', newMode = 'read', newAllow = '', onNewField, onCreate } = props;
  return h('div', null, [
    h('div', { style: 'font-weight:600' }, `📤 Share "${title}"`),
    h('div', { class: 'sub', style: 'margin:6px 0 8px' }, 'Your links for this chat — each is independent (its own permission + allowance).'),
    links.length ? h('div', null, links.map(s => linkRow(s, props))) : EmptyState({ text: 'no links yet — create one below' }),
    h('div', { style: 'border-top:1px solid var(--edge);margin-top:12px;padding-top:10px' }, [
      h('div', { style: 'font-weight:600;font-size:13px;margin-bottom:6px' }, 'Create a new link'),
      TextField({ value: newName, placeholder: 'name this link (e.g. kumavis · read-only)', onInput: v => onNewField && onNewField('name', v) }),
      h('div', { style: 'margin:6px 0' }, RadioGroup({ name: 'shmode', value: newMode, options: [{ value: 'read', label: 'Read-only — view only' }, { value: 'write', label: 'Write — can post + drive the agent' }], onChange: v => onNewField && onNewField('mode', v) })),
      h('label', { class: 'sub' }, ['Spend allowance (USD, optional): ', TextField({ type: 'number', value: newAllow, placeholder: '0', onInput: v => onNewField && onNewField('allow', v) })]),
      Btn({ label: 'Create link', variant: 'primary', onClick: () => onCreate && onCreate() }),
    ]),
  ]);
};
