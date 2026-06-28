import { h } from 'preact';

// ── TaglineHero island — the landing hero line shown (centred) above the composer before the first message
// ("What can Agent C do for you?"). The smallest shell→island migration (P4 of designs/live-editable-everything.md):
// a hand-written static <div> becomes a confined, alt-clickable, editable component — alt-click it and ask its
// agent to change the wording. Stateless + render-safe: just a text prop. Props: { text }.
export const TaglineHero = (props = {}) =>
  h('div', { class: 'tagline-hero' }, (props && props.text) || 'What can Agent C do for you?');
