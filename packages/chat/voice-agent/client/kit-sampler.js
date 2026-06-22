import { h } from 'preact';
import {
  Btn, Chip, Badge, Card, EmptyState, IconBtn, Spinner, Avatar, ProgressBar,
  Banner, Divider, Toggle, Checkbox, RadioGroup, Select, TextField, Textarea, Tabs, Field,
} from './ui-kit.js';

// ── KitSampler — a LIVING STYLE GUIDE: one of every confined-Preact ui-kit primitive, rendered through
// the real bundle. It's the gallery's "framework" view, and the regression surface for the design system:
// if a primitive breaks, this stops rendering. Stateless (showcase values are fixed).
const sec = (title, ...kids) => h('div', null, [h('h4', null, title), h('div', { class: 'kit-rowx' }, kids)]);

export const KitSampler = () => h('div', { class: 'kit-sampler' }, [
  sec('Buttons', Btn({ label: 'Default' }), Btn({ label: 'Primary', variant: 'primary' }), Btn({ label: 'Danger', variant: 'bad' }), Btn({ label: 'Disabled', disabled: true }), IconBtn({ glyph: '↻', title: 'retry' }), IconBtn({ glyph: '✎', title: 'edit' })),
  sec('Chips & badges', Chip({ label: 'web' }), Chip({ label: 'revoked', kind: 'bad' }), Badge({ label: '3' }), Badge({ label: 'NEW', kind: 'mut' }), Badge({ label: '!', kind: 'bad' })),
  sec('Avatars & loading', Avatar({ label: '🤖' }), Avatar({ label: 'DA' }), Spinner({ label: 'working…' })),
  h('h4', null, 'Progress'), ProgressBar({ value: 0.6 }),
  h('h4', null, 'Inputs'),
  Field({ label: 'Text', control: TextField({ value: 'hello', placeholder: 'type…' }) }),
  Field({ label: 'Select', control: Select({ value: 'b', options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] }) }),
  Field({ label: 'Notes', hint: 'multi-line', control: Textarea({ value: 'multi\nline', rows: 2 }) }),
  sec('Choices', Checkbox({ label: 'Remember me', checked: true }), Toggle({ label: 'Dark mode', checked: true })),
  RadioGroup({ name: 'demo', value: 'two', inline: true, options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' }] }),
  Divider(),
  h('h4', null, 'Tabs'), Tabs({ tabs: [{ id: 't1', label: 'First' }, { id: 't2', label: 'Second' }], active: 't1' }),
  h('h4', null, 'Banners'),
  h('div', { class: 'kit-stack' }, [
    Banner({ kind: 'info', icon: 'ℹ️', children: 'Informational message.' }),
    Banner({ kind: 'success', icon: '✅', children: 'It worked.' }),
    Banner({ kind: 'warn', icon: '⚠️', children: 'Careful.' }),
    Banner({ kind: 'error', icon: '⛔', children: 'Something failed.' }),
  ]),
  h('h4', null, 'Card'), Card({ title: 'A card', time: '2m', body: 'Card body text.', footer: h('span', { class: 'sub' }, 'footer meta') }),
  h('h4', null, 'Empty state'), EmptyState({ text: 'nothing here yet' }),
]);
