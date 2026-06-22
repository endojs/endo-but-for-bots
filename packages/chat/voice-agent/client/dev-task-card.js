import { h } from 'preact';
import { Btn } from './ui-kit.js';

// ── DevTaskCard island — a Blacksmith/dev task routed from a chat: who + status, the task + result, and
// a collapsible reply thread (replies route ONLY to the dev task, never the top-level conversation).
// Stateless: `expanded` + the reply `draft` live in the host. Render-safe text.
//
// Props: { task:{id,to,status,task,result,thread:[{role,text}]}, accent, who, expanded, draft }
// Handlers: { onToggle(), onReplyChange(v), onReplySend() }
const statusLabel = s => (s === 'done' ? '✓ done' : s === 'error' ? '⚠ error' : '⏳ working…');

export const DevTaskCard = (props = {}) => {
  const { task = {}, accent = '', who = task.to || 'blacksmith', expanded = false, draft = '', onToggle, onReplyChange, onReplySend } = props;
  const thread = task.thread || [];
  return h('div', { class: 'msg', style: accent ? `border-color:${accent}` : undefined }, [
    h('div', { class: 'who', style: accent ? `color:${accent}` : undefined }, `🔨 ${who} · ${statusLabel(task.status)}`),
    h('div', { class: 'body' }, `${task.task || ''}${task.result ? `\n\n→ ${task.result}` : ''}`),
    h('div', { class: 'dev-thread' }, [
      h('button', { class: 'dev-thread-toggle', style: accent ? `color:${accent}` : undefined, onClick: () => onToggle && onToggle() },
        `${expanded ? '▾' : '▸'} reply in thread${thread.length ? ` (${thread.length})` : ''}`),
      expanded ? h('div', { class: 'dev-thread-body', style: accent ? `border-color:${accent}` : undefined }, [
        ...thread.map((m, i) => h('div', { class: 'dev-thread-msg', key: i }, [
          h('b', { style: `color:${m.role === 'you' ? 'var(--you)' : (accent || 'var(--acc)')}` }, m.role === 'you' ? 'you' : who), ' ', m.text || '',
        ])),
        h('div', { class: 'dev-thread-row kit-rowx' }, [
          h('input', { class: 'ask-in', value: draft, placeholder: `reply to ${who}…`, onInput: e => onReplyChange && onReplyChange(e.target.value), onKeyDown: e => { if (e.key === 'Enter') onReplySend && onReplySend(); } }),
          Btn({ label: 'Send', onClick: () => onReplySend && onReplySend() }),
        ]),
      ]) : null,
    ]),
  ]);
};
