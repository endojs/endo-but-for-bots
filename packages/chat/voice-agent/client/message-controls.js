import { h } from 'preact';
import { IconBtn } from './ui-kit.js';

// ── MessageControls island — the per-message action row: ↻ retry, ✎ edit, 🔊 audio (if any), and a
// ◀ k/n ▶ fork navigator when the answer has variants. Render-safe scalars only; handlers are bound to
// the host's turn index. Factored onto the kit's IconBtn.
//
// Props: { hasAudio, varIx, varCount } + handlers { onRetry(), onEdit(), onPlayAudio(), onFork(delta) }
export const MessageControls = (props = {}) => {
  const { hasAudio = false, varIx = 0, varCount = 1, onRetry, onEdit, onPlayAudio, onFork } = props;
  const kids = [
    IconBtn({ glyph: '↻', title: 'Retry with the current model + parameters (creates a fork)', onClick: () => onRetry && onRetry() }),
    IconBtn({ glyph: '✎', title: 'Edit this message and retry', onClick: () => onEdit && onEdit() }),
    hasAudio ? IconBtn({ glyph: '🔊', title: 'Play the original audio', onClick: () => onPlayAudio && onPlayAudio() }) : null,
  ];
  if (varCount > 1) {
    kids.push(h('span', { class: 'kit-rowx', style: 'margin-left:auto' }, [
      IconBtn({ glyph: '◀', title: 'Previous fork (restores its model + params)', onClick: () => onFork && onFork(-1) }),
      h('span', { style: 'font-variant-numeric:tabular-nums;font-size:11px;color:var(--acc)' }, `${varIx + 1}/${varCount}`),
      IconBtn({ glyph: '▶', title: 'Next fork', onClick: () => onFork && onFork(1) }),
    ]));
  }
  return h('div', { class: 'msg-ctrl kit-rowx', style: 'margin:-4px 2px 6px;font-size:12px' }, kids);
};
