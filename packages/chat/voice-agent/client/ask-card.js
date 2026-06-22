import { h } from 'preact';
import { Chip, Btn, RadioGroup, Checkbox, TextField, Textarea } from './ui-kit.js';

// ── AskCard island — the inline feedback-loop card: a STRUCTURED, typed question rendered with kit
// controls. STATELESS by the island contract: the in-progress answers live in `answers` (host/cell),
// updated through onChange(qid, value); the host owns + submits them. Keeps the existing .ask shell
// classes for visual continuity, but every input is now a reusable kit primitive.
//
// SECRET HYGIENE: a `secret` answer is a masked, UNCONTROLLED password input — its value is read into
// host state (for the submit POST) but never bound back / re-rendered; once answered the host clears it
// and the field becomes a "stored securely" chip.
//
// Props: { ask:{id,title,body,questions:[{id,q,type,options}],requestedBy}, answers:{qid:value}, status }
// Handlers: { onChange(qid,value), onSubmit(askId), onOpenOrigin() }
const control = (ask, q, answers, status, onChange) => {
  const v = answers[q.id];
  const dis = !!status;
  if (q.type === 'choice' || q.type === 'bool' || q.type === 'approve-reject') {
    const opts = q.type === 'bool' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
      : q.type === 'approve-reject' ? [{ value: 'approve', label: '✅ Approve' }, { value: 'reject', label: '❌ Reject' }]
        : (q.options || []).map(o => ({ value: o, label: o }));
    return RadioGroup({ name: `${ask.id}-${q.id}`, value: v, options: opts, inline: true, onChange: val => onChange(q.id, val) });
  }
  if (q.type === 'multiselect') {
    const cur = Array.isArray(v) ? v : [];
    return h('div', { class: 'kit-stack' }, (q.options || []).map((o, i) =>
      Checkbox({ key: i, label: o, checked: cur.includes(o), disabled: dis, onChange: chk => onChange(q.id, chk ? [...cur, o] : cur.filter(x => x !== o)) })));
  }
  if (q.type === 'number') return TextField({ type: 'number', value: v == null ? '' : String(v), placeholder: 'number', disabled: dis, onInput: val => onChange(q.id, val === '' ? null : Number(val)) });
  if (q.type === 'secret') return status
    ? Chip({ label: '🔒 stored securely — never shown again' })
    : h('input', { class: 'kit-in', type: 'password', autocomplete: 'off', placeholder: '🔒 stored securely — never shown or logged', onInput: e => onChange(q.id, e.target.value) });
  return Textarea({ value: v || '', rows: 2, placeholder: 'your answer', disabled: dis, onInput: val => onChange(q.id, val) });
};

export const AskCard = (props = {}) => {
  const { ask = {}, answers = {}, status = '', accent = '', onChange, onSubmit, onOpenOrigin } = props;
  const fn = onChange || (() => {});
  return h('div', { class: 'ask', style: accent ? `border-left:3px solid ${accent}` : undefined }, [
    h('div', { class: 'ask-title' }, ['❓ ', h('span', null, ask.title || ''), ask.requestedBy ? h('span', null, [' ', Chip({ label: ask.requestedBy })]) : null]),
    ask.body ? h('div', { class: 'ask-body' }, ask.body) : null,
    ...(ask.questions || []).map((q, i) => h('div', { class: 'ask-q', key: i }, [
      h('div', { class: 'ask-qtext' }, q.q),
      h('div', { class: 'ask-ctrl' }, control(ask, q, answers, status, fn)),
    ])),
    h('div', { class: 'ask-btns' }, [
      status ? Chip({ label: '✓ answered' }) : Btn({ label: 'Submit', variant: 'primary', onClick: () => onSubmit && onSubmit(ask.id) }),
      onOpenOrigin ? Btn({ label: '→ open conversation', onClick: () => onOpenOrigin() }) : null,
    ]),
  ]);
};
