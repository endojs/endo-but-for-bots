// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { h, renderConfined, unmount } from '@endo/preact-container/renderer';
import {
  InteractiveWidget,
  widgetMessageParts,
} from '@endo/spaces-util/interactive-widget.js';
import { markdownToVnodes } from '@endo/spaces-util/markdown-vnodes.js';
// Exercise the internal view without widening the package's public API.
// eslint-disable-next-line import/no-relative-packages
import { MessageList } from '../../../space-floot/src/MessageList.js';
import { createDOM, waitFor } from '../helpers/dom-setup.js';

const dom = createDOM();
const testWindow = /** @type {Window & typeof globalThis} */ (
  /** @type {unknown} */ (dom.window)
);
const doc = /** @type {Document} */ (/** @type {unknown} */ (dom.document));
globalThis.requestAnimationFrame = fn => testWindow.setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
const counter = `({h,useState}) => { const [n,set] = useState(0); return h('button', {onClick: () => set(n+1)}, 'Count ' + n); }`;
const fence = source => `\`\`\`endowidget\n${source}\n\`\`\``;
const mount = t => {
  const parent = doc.createElement('div');
  doc.body.append(parent);
  t.teardown(() => {
    unmount(parent);
    parent.remove();
  });
  return parent;
};
const click = el =>
  el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

test.serial(
  'completed Floot/Fae widgets interact and source replacement resets state',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    renderConfined(
      h('div', null, ...markdownToVnodes(fence(counter)).nodes),
      parent,
    );
    await waitFor(() => !!parent.querySelector('button'));
    click(parent.querySelector('button'));
    await waitFor(() => parent.textContent.includes('Count 1'));
    renderConfined(h(InteractiveWidget, { source: `${counter} ` }), parent);
    await waitFor(() => parent.textContent.includes('Count 0'));
    t.true(parent.textContent.includes('Interactive widget'));
  },
);

test.serial(
  'Compartment denies ambient authority and constructor escapes',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    const source = `({h}) => {
    let escaped = false;
    try { h.constructor('return globalThis')(); escaped = true; } catch {}
    return h('p', null, [typeof document,typeof window,typeof fetch,typeof localStorage,typeof setTimeout,typeof powers,String(escaped)].join(','));
  }`;
    renderConfined(h(InteractiveWidget, { source }), parent);
    await waitFor(() => parent.textContent.includes('undefined'));
    t.true(
      parent.textContent.endsWith(
        'undefined,undefined,undefined,undefined,undefined,undefined,false',
      ),
    );
  },
);

test.serial(
  'forged nodes cannot load resources, style chrome, submit forms, or expose DOM events',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    const source = `({h,useState}) => {
    const [value,set] = useState('initial');
    return {type:'div',props:{style:'position:fixed;inset:0;background:url(https://evil.test)',class:'floot-header',id:'host',children:[
      h('img',{src:'https://evil.test'}),h('form',{action:'https://evil.test'}),h('svg',null,h('image',{href:'https://evil.test'})),
      h('input',{type:'file',form:'host',name:'secret',onChange:e=>set(typeof e.target.ownerDocument)}),
      h('button',{type:'submit',formAction:'https://evil.test',ref:()=>set('ref escaped'),onClick:e=>set([typeof e.target.ownerDocument,typeof e.view,typeof e.composedPath,String(Object.isFrozen(e))].join(','))},value)
    ]}};
  }`;
    renderConfined(h(InteractiveWidget, { source }), parent);
    await waitFor(() => !!parent.querySelector('button'));
    t.is(
      parent.querySelector(
        'img,form,svg,[src],[href],[form],[formaction],[name],#host',
      ),
      null,
    );
    t.is(parent.querySelector('.floot-header'), null);
    t.is(parent.querySelector('input')?.type, 'text');
    t.is(parent.querySelector('button')?.type, 'button');
    t.is(parent.querySelector('section > div')?.getAttribute('style'), null);
    click(parent.querySelector('button'));
    await waitFor(() =>
      parent.textContent.includes('undefined,undefined,undefined,true'),
    );
    t.false(parent.textContent.includes('ref escaped'));
  },
);

test.serial(
  'invalid, oversized, render and event failures stay inside the widget',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    for (const source of [
      'oops(',
      '() => {throw Error("private")}',
      'x'.repeat(65_537),
      '() => {const a=[];a.push(a);return a}',
    ]) {
      renderConfined(h(InteractiveWidget, { source }), parent);
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() =>
        parent.textContent.includes('could not be displayed'),
      );
      t.false(parent.textContent.includes('private'));
    }
    renderConfined(
      h(InteractiveWidget, {
        source:
          '({h}) => h("button",{onClick:()=>{throw Error("private")}},"break")',
      }),
      parent,
    );
    await waitFor(() => !!parent.querySelector('button'));
    click(parent.querySelector('button'));
    await waitFor(() => parent.textContent.includes('could not be displayed'));
    t.pass();
  },
);

test('incomplete and nested example fences remain text', t => {
  const incomplete = `\`\`\`endowidget\n${counter}`;
  t.deepEqual(widgetMessageParts(incomplete), [{ text: incomplete }]);
  const example = `\`\`\`\`js\n${fence(counter)}\n\`\`\`\``;
  t.deepEqual(widgetMessageParts(example), [{ text: example }]);
  t.deepEqual(widgetMessageParts(`before\n${fence(counter)}\nafter`), [
    { text: 'before\n' },
    { source: counter },
    { text: '\nafter' },
  ]);
});

test.serial('unfinished markdown fence stays inert', async t => {
  const parent = mount(t);
  renderConfined(
    h('div', null, ...markdownToVnodes(`\`\`\`endowidget\n${counter}`).nodes),
    parent,
  );
  t.is(parent.querySelector('button'), null);
  t.truthy(parent.querySelector('pre'));
});

test.serial(
  'Floot renders assistant widgets only after completion and isolates sessions',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    /** @type {any} */
    const state = {
      messages: [],
      streamingText: fence(counter),
      loaded: true,
      activeSessionId: 'one',
    };
    const render = () =>
      renderConfined(
        h(MessageList, {
          state: /** @type {any} */ (state),
          controller: /** @type {any} */ ({}),
        }),
        parent,
      );
    render();
    t.is(parent.querySelector('.endo-interactive-widget'), null);
    state.streamingText = '';
    state.messages = [{ role: 'user', text: fence(counter) }];
    render();
    t.is(parent.querySelector('.endo-interactive-widget'), null);
    state.messages = [{ role: 'assistant', text: fence(counter) }];
    render();
    await waitFor(
      () => !!parent.querySelector('.endo-interactive-widget button'),
    );
    click(parent.querySelector('.endo-interactive-widget button'));
    await waitFor(() => parent.textContent.includes('Count 1'));
    state.activeSessionId = 'two';
    render();
    await waitFor(() => parent.textContent.includes('Count 0'));
    t.pass();
  },
);

test.serial(
  'reducers never receive Preact hook state as their receiver',
  async t => {
    t.timeout(5000);
    const parent = mount(t);
    const source = `({h,useReducer}) => {
    const [value,dispatch]=useReducer(function(value,action){return this===undefined ? action : 'leaked '+Object.keys(this).join(',')},'initial',function(value){return this===undefined ? value : 'init leaked'});
    return h('button',{onClick:()=>dispatch('safe')},value);
  }`;
    renderConfined(h(InteractiveWidget, { source }), parent);
    await waitFor(() => !!parent.querySelector('button'));
    t.is(parent.querySelector('button')?.textContent, 'initial');
    click(parent.querySelector('button'));
    await waitFor(() => parent.querySelector('button')?.textContent === 'safe');
    t.false(parent.textContent.includes('leaked'));
  },
);
