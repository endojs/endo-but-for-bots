// @ts-check

/** Protocol shared by Fae chat replies and Floot's hosted/provider agents. */
export const widgetPrompt = `
## Interactive replies

When an interactive calculator, checklist, selector, or small exploration helps,
you can include a fenced code block with language endowidget in your final reply.
The Endo chat UI renders it with confined Preact in a fresh SES Compartment.
The source must be one JavaScript function expression, without JSX or imports:

\`\`\`endowidget
({ h, useState }) => {
  const [count, setCount] = useState(0);
  return h('button', { onClick: () => setCount(n => n + 1) }, 'Count: ' + count);
}
\`\`\`

Available hooks: useState, useReducer, useMemo, useCallback. Use ordinary HTML
text/layout tags, tables, labels, buttons, inputs, selects, and textareas.
Use h(tag, props, ...children); component functions and Fragment are not supported.
Events: onClick, onInput, onChange, onKeyDown. Events are frozen safe snapshots;
read event.target.value or event.target.checked, never DOM nodes or refs.
The widget has local state only; it cannot send a chat turn or call agent tools.
No network, filesystem, timers, effects, DOM, imports, links, forms, images, CSS,
class names, or ids are available. Styling follows the host theme.
Widgets are bounded to 65,536 source code units and 2048 rendered nodes with depth 32.
State resets when the message is unmounted or its source changes. Do not promise
persistence or show a fake successful external operation. Keep a brief plain-text
explanation outside the fence for speech and clients without widget rendering.
Never put secrets or capability URLs into widget source.
`;
harden(widgetPrompt);
