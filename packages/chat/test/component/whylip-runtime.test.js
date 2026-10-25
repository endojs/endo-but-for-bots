// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { h } from 'preact';

// Exercise the private runtime without making it part of the package API.
// eslint-disable-next-line import/no-relative-packages
import { makeSceneRuntime } from '../../../space-whylip/src/scene-runtime.js';
import { createDOM, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument, window: testWindow } = createDOM();

/** @param {import('ava').ExecutionContext} t */
const setup = t => {
  const parent = testDocument.createElement('div');
  testDocument.body.appendChild(parent);
  t.teardown(() => {
    unmount(parent);
    parent.remove();
  });
  return { parent, runtime: makeSceneRuntime() };
};

const source =
  label => `({h}, {state, update, act}) => h('section', {key:'page'},
  h('input', {key:'reader', id:'reader', value:state.name || '', onInput:event => update({name:event.target.value})}),
  h('p', {key:'words'}, ${JSON.stringify(label)}),
  h('button', {key:'next', onClick:() => act('next', {name:state.name})}, 'Next'))`;

test.serial(
  'live source edits retain input identity, focus, selection and reader state',
  async t => {
    const { parent, runtime } = setup(t);
    let state = { name: 'Ada' };
    let text = source('A small lantern');
    const actions = [];
    const draw = () =>
      renderConfined(
        h(runtime.Component, {
          source: text,
          state,
          onState: patch => {
            state = { ...state, ...patch };
            draw();
          },
          onAction: (name, detail) => actions.push({ name, detail }),
        }),
        parent,
      );
    draw();
    await waitFor(() => parent.querySelector('input'));
    const input = parent.querySelector('input');
    if (!input) throw Error('Missing reader input');
    input.focus();
    input.value = 'Ada Lovelace';
    input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await waitFor(() => state.name === 'Ada Lovelace');
    input.setSelectionRange(2, 5);
    text = source('The lantern begins to glow');
    draw();
    await waitFor(() => parent.textContent.includes('begins to glow'));
    t.is(parent.querySelector('input'), input);
    t.is(testDocument.activeElement, input);
    t.is(input.value, 'Ada Lovelace');
    t.is(input.selectionStart, 2);
    t.is(input.selectionEnd, 5);
    parent.querySelector('button')?.click();
    t.deepEqual(actions, [{ name: 'next', detail: { name: 'Ada Lovelace' } }]);
    t.is(runtime.getError(), null);
  },
);

test.serial(
  'incomplete source and render failures retain the working interactive scene',
  async t => {
    const { parent, runtime } = setup(t);
    const actions = [];
    const draw = code =>
      renderConfined(
        h(runtime.Component, {
          source: code,
          state: { name: 'Ada' },
          onAction: name => actions.push(name),
        }),
        parent,
      );
    draw(source('Working scene'));
    await waitFor(() => parent.querySelector('input'));
    const input = parent.querySelector('input');
    if (!input) throw Error('Missing reader input');
    input.focus();
    for (const invalid of [
      '({h}, props) => {',
      '() => { throw Error("unfinished scene"); }',
      '({h}) => h(() => null)',
    ]) {
      draw(invalid);
      // renderConfined flushes asynchronously; wait for the diagnostic.
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => runtime.getError());
      t.is(parent.querySelector('input'), input);
      t.is(testDocument.activeElement, input);
      t.true(parent.textContent.includes('Working scene'));
      parent.querySelector('button')?.click();
    }
    t.is(actions.length, 3);
    draw(source('Repaired scene'));
    await waitFor(() => parent.textContent.includes('Repaired scene'));
    t.is(runtime.getError(), null);
    t.is(parent.querySelector('input'), input);
  },
);

test.serial(
  'scene compartment has no ambient browser powers, hooks, or host return values',
  async t => {
    const { parent, runtime } = setup(t);
    const reports = [];
    const code = `({h, useState}, {act, update}) => h('button', {onClick:event => {
    let escaped = false;
    try { h.constructor('return globalThis')(); escaped = true; } catch (_) {}
    const result = update({touched:true});
    act('probe', { document:typeof document, window:typeof window, fetch:typeof fetch,
      timers:typeof setTimeout, hooks:typeof useState, escaped, result:typeof result,
      targetDocument:typeof event.target.ownerDocument, eventView:typeof event.view,
      frozen:Object.isFrozen(event) });
  }}, 'Inspect')`;
    renderConfined(
      h(runtime.Component, {
        source: code,
        onState: () => testDocument,
        onAction: (name, detail) => reports.push({ name, detail }),
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('button'));
    parent.querySelector('button')?.click();
    t.deepEqual(reports, [
      {
        name: 'probe',
        detail: {
          document: 'undefined',
          window: 'undefined',
          fetch: 'undefined',
          timers: 'undefined',
          hooks: 'undefined',
          escaped: false,
          result: 'undefined',
          targetDocument: 'undefined',
          eventView: 'undefined',
          frozen: true,
        },
      },
    ]);
  },
);

test.serial(
  'confined renderer strips raw HTML, forbidden tags and DOM refs',
  async t => {
    const { parent, runtime } = setup(t);
    renderConfined(
      h(runtime.Component, {
        source: `({h}) => h('div', {id:'safe', ref:() => { throw Error('DOM ref escaped'); }, dangerouslySetInnerHTML:{__html:'<script>bad()</script>'}}, h('script', null, 'ignored'), h('iframe', {srcdoc:'bad'}), h('a', {href:'javascript:bad()'}, 'Link'))`,
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('#safe'));
    t.is(parent.querySelector('script'), null);
    t.is(parent.querySelector('iframe'), null);
    t.is(parent.querySelector('a')?.getAttribute('href'), null);
    t.is(runtime.getError(), null);
  },
);

test.serial(
  'render-time actions cannot wake the agent or mutate reader state',
  async t => {
    const { parent, runtime } = setup(t);
    const calls = [];
    renderConfined(
      h(runtime.Component, {
        source: `({h}, {act}) => { act('side-effect'); return h('p', null, 'bad'); }`,
        onAction: () => calls.push('action'),
      }),
      parent,
    );
    await waitFor(() => runtime.getError());
    t.deepEqual(calls, []);
    t.regex(runtime.getError() || '', /event handlers/);
  },
);

test.serial(
  'SVG book assets render as inert images and asset lookup only resolves supplied file entries',
  async t => {
    const { parent, runtime } = setup(t);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="10"/></svg>';
    renderConfined(
      h(runtime.Component, {
        source: `({h}, {asset}) => h('div', null,
      h('img', {id:'owl', src:asset('assets/owl.svg'), alt:'Owl'}),
      h('p', {id:'missing'}, [asset('assets/missing.svg'), asset('https://example.com/owl.svg'), asset('scene.js'), asset('toString')].join('|')))`,
        assets: { 'assets/owl.svg': svg, 'scene.js': 'not an image' },
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('#owl'));
    t.is(
      parent.querySelector('img')?.getAttribute('src'),
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
    t.is(parent.querySelector('#missing')?.textContent, '|||');
    t.is(parent.querySelector('svg'), null);
    t.is(runtime.getError(), null);
  },
);

test.serial(
  'render-scheduled microtasks cannot wake the agent outside a user event',
  async t => {
    const { parent, runtime } = setup(t);
    const reports = [];
    renderConfined(
      h(runtime.Component, {
        source: `({h}, {act}) => { let blocked = false;
      Promise.resolve().then(() => { try { act('unsolicited'); } catch (_) { blocked = true; } });
      return h('button', {onClick:() => act('reader', {blocked})}, 'Report'); }`,
        onAction: (name, detail) => reports.push({ name, detail }),
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('button'));
    parent.querySelector('button')?.click();
    t.deepEqual(reports, [{ name: 'reader', detail: { blocked: true } }]);
  },
);

test.serial(
  'Three descriptions and events cross the compartment as inert data',
  async t => {
    const { parent, runtime } = setup(t);
    let state = { rings: 0 };
    const actions = [];
    const draw = () =>
      renderConfined(
        h(runtime.Component, {
          source: `({h}, {state, update, act}) => ({
      scene:h('scene',{key:'world'}, h('mesh',{key:'bell',
        geometry:{type:'sphere',radius:1},material:{color:state.rings ? '#ff0000' : '#ffffff'},
        onClick:event => { update({rings:state.rings+1}); act('bell', {
          frozen:Object.isFrozen(event), point:event.point,
          dom:typeof event.target, three:typeof THREE, document:typeof document
        }); }})),
      overlay:h('p',null,'Rings: '+state.rings)
    })`,
          state,
          onState: patch => {
            state = { ...state, ...patch };
            draw();
          },
          onAction: (name, detail) => actions.push({ name, detail }),
        }),
        parent,
      );
    draw();
    await waitFor(() => runtime.getScene());
    const graph = runtime.getScene();
    t.true(Object.isFrozen(graph));
    const id = graph.props.children[0].props.onClick;
    t.is(typeof id, 'string');
    runtime.dispatchSceneEvent({
      type: 'click',
      id,
      key: 'bell',
      point: [1, 2, 3],
    });
    await waitFor(() => parent.textContent.includes('Rings: 1'));
    t.is(runtime.getScene().props.children[0].props.material.color, '#ff0000');
    t.deepEqual(actions, [
      {
        name: 'bell',
        detail: {
          frozen: true,
          point: [1, 2, 3],
          dom: 'undefined',
          three: 'undefined',
          document: 'undefined',
        },
      },
    ]);
    t.is(runtime.getError(), null);
  },
);

test.serial(
  'malformed Three edits preserve the last working graph and event handlers',
  async t => {
    const { parent, runtime } = setup(t);
    const actions = [];
    const valid = `({h}, {act}) => ({scene:h('scene',{key:'world'},h('mesh',{key:'bell',geometry:{type:'box'},material:{color:'#ffaa00'},onClick:()=>act('bell')})),overlay:h('p',null,'Working world')})`;
    const draw = sourceText =>
      renderConfined(
        h(runtime.Component, {
          source: sourceText,
          onAction: name => actions.push(name),
        }),
        parent,
      );
    draw(valid);
    await waitFor(() => runtime.getScene());
    for (const invalid of [
      valid.replace("type:'box'", "type:'arbitrary-constructor'"),
      valid.replace("key:'bell'", "key:'world'"),
      valid.replace(
        "material:{color:'#ffaa00'}",
        "material:{get color(){throw Error('getter ran')}}",
      ),
      valid.replace("key:'bell'", "key:'bell',ref:()=>act('escaped')"),
    ]) {
      draw(invalid);
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => runtime.getError());
      t.is(parent.textContent, 'Working world');
      const graph = runtime.getScene();
      t.is(graph.props.children[0].props.geometry.type, 'box');
      runtime.dispatchSceneEvent({
        type: 'click',
        id: graph.props.children[0].props.onClick,
        key: 'bell',
        point: [0, 0, 0],
      });
    }
    t.deepEqual(actions, ['bell', 'bell', 'bell', 'bell']);
  },
);

test.serial(
  'Three copy budgets reject shared-array expansion and oversized properties before graph validation',
  async t => {
    t.timeout(5000);
    const { parent, runtime } = setup(t);
    const draw = code =>
      renderConfined(h(runtime.Component, { source: code }), parent);
    draw(
      `({h}) => ({scene:h('scene',{key:'world'}),overlay:h('p',null,'Working world')})`,
    );
    await waitFor(() => runtime.getScene());
    /** @type {[string, RegExp][]} */
    const cases = [
      [
        // Seven small arrays would expand to over 268 million elements.
        `let children = null; for (let i = 0; i < 7; i += 1) children = Array(16).fill(children);`,
        /copy budget/,
      ],
      [
        `const children = Object.fromEntries(Array.from({length:16385}, (_, i) => ['p'+i, undefined]));`,
        /property budget/,
      ],
      [`const children = Array(4).fill('x'.repeat(300000));`, /text budget/],
    ];
    for (const [prepare, expected] of cases) {
      draw(
        `({h}) => { ${prepare} return {scene:h('scene',{key:'world'}, children),overlay:h('p',null,'Bad world')}; }`,
      );
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expected.test(runtime.getError() || ''));
      t.regex(runtime.getError() || '', expected);
      t.is(parent.textContent, 'Working world');
      t.is(runtime.getScene().props.key, 'world');
    }
  },
);
