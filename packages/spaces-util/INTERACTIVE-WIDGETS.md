# Interactive message widgets

Floot and Fae can include an `endowidget` code fence in a reply.
A completed fence renders inline in Floot and in the shared chat/channel Markdown
renderer; other clients retain the source as readable text.
A widget is a single JavaScript function expression, without JSX or imports:

````markdown
Here is a counter you can try:

```endowidget
({ h, useState }) => {
  const [count, setCount] = useState(0);
  return h('button', { onClick: () => setCount(n => n + 1) }, `Count: ${count}`);
}
```
````

The component receives `h`, `useState`, `useReducer`, `useMemo`, and `useCallback`.
Use text/layout elements, tables, buttons, labels, inputs, selects, and textareas.
Supported events are `onClick`, `onInput`, `onChange`, and `onKeyDown`.
Event targets expose safe value/checked snapshots, not browser elements.
The host supplies appearance and follows its selected color scheme.

Each mounted source gets a fresh SES `Compartment` with no host globals or imports.
It runs through `confineComponent` and the existing `renderConfined` tree after
severe SES lockdown.
A second, narrower output profile copies the entire returned tree, including
hand-built vnodes, and admits only local controls and primitive attributes.
It excludes styles, classes, ids, refs, links, forms, resource-loading elements,
SVG, custom components, and all daemon/session callbacks.
This closes the generic renderer's documented URL/CSS resource-loading channels
for this surface.
No message references or capability URLs should be put in source code.

Source is limited to 65,536 JavaScript code units; output has a 2,048-node budget
and maximum depth of 32.
Rendering and event failures produce a local fallback without displaying guest
exception details.
SES is an authority boundary, not CPU or memory metering: synchronous generated
code runs on the UI thread and can still consume excessive resources.
This implementation does not promise process isolation or an execution timeout.

Floot evaluates widgets only in settled assistant messages, never user input or
streaming text.
The shared Markdown view requires a closing fence; unclosed fences stay code.
Widget state is local to its mount and resets on source change or session switch.
It cannot submit a chat turn, invoke tools, or persist state.
Include a plain-text explanation outside the fence for speech and other clients.
The built-in speech service discards fenced code incrementally before sentence
chunking, including fences split across transport chunks.

New Floot preset sessions and Fae's default prompt include this protocol.
Existing session prompts remain snapshots; an existing agent can use the protocol
when given the example above.

Regression checks:

- `yarn workspace @endo/chat test test/component/interactive-widget.test.js`
- `yarn workspace @endo/chat test:widgets` (Playwright Chromium; optional `CHROME`
  executable override)
- `yarn workspace @endo/floot test test/speech-code-filter.test.js`
