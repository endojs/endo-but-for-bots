import { h, Fragment } from 'preact';

// ── MessageBubble island (P4 shell→island migration) — the per-message bubble SHELL: a .who label row + a
// .body slot. Rendered PER MESSAGE into the .msg container; app.js then fills .who (label/time/profile click)
// and .body (markdown / linkified text / images / widgets) imperatively — the .body is a slot, which composes
// because this renders once per bubble. Editing this island re-flows EVERY message bubble (the template). Keep
// the .who / .body classes EXACTLY — app.js fills them by class.
export const MessageBubble = () => h(Fragment, {}, [
  h('div', { class: 'who' }),
  h('div', { class: 'body' }),
]);
