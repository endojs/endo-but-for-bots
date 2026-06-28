import { h, Fragment } from 'preact';
export const InputRow = () => h(Fragment, {}, [
  h('button', { id: 'attach', title: 'Attach a photo or file' }, '📎'),
  h('input', { id: 'file', type: 'file', multiple: true, accept: 'image/*,.txt,.md,.markdown,.csv,.json,text/*', class: 'hide' }),
  h('textarea', { id: 'text', rows: '1', placeholder: 'Message Agent C…', autocomplete: 'off', enterkeyhint: 'send' }),
  h('button', { id: 'send', title: 'Send' }, '➤'),
  h('button', { id: 'mic', title: 'Voice mode — tap to talk' }, '🎤'),
  h('button', { id: 'meeting-btn', title: 'Record a multi-speaker meeting' }, '👥'),
]);
