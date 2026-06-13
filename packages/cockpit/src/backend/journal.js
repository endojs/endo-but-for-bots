// @ts-check
//
// Journal transcript export: a thread's transcript rendered in the garden's
// journal-entry shape (designs/garden-cockpit.md § Relationships —
// threads≈dispatches, journal≈transcript). Returns markdown; the operator (or
// a later integration) decides where it lands.

const renderEvent = ev => {
  const body =
    ev.message !== undefined
      ? `: ${ev.message}`
      : ev.data !== undefined
        ? `: ${typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}`
        : '';
  return `- ${ev.kind}${body}`;
};

/**
 * @param {{ toJSON: () => any, transcript: () => any[] }} thread
 * @returns {string}
 */
export const exportTranscript = thread => {
  const j = thread.toJSON();
  const caps = j.caps.map(c => `${c.name}:${c.mode || '—'}`).join(', ') || 'none';
  return [
    '---',
    'type: thread-transcript',
    `thread: ${j.id}`,
    `template: ${j.templateName}`,
    `status: ${j.status}`,
    '---',
    '',
    `# transcript: ${j.id} (${j.templateName})`,
    '',
    `caps: ${caps}`,
    `o11y: ${j.o11y.tokens} tokens, ${j.o11y.turns} turns`,
    '',
    ...thread.transcript().map(renderEvent),
    '',
  ].join('\n');
};
