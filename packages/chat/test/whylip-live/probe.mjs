// Browser fixture: real SES confinement, Preact reconciliation, and starter scene.
import 'ses';

lockdown({ overrideTaming: 'severe' });

const { h } = await import('preact');
const { renderConfined } = await import('@endo/preact-container/renderer');
const { SceneCanvas } =
  await import('../../../space-whylip/src/SceneCanvas.js');
const { STARTER_SCENE, STARTER_STATE } =
  await import('../../../space-whylip/src/starter-scene.js');
await import('../../../space-whylip/src/whylip.css');

const container = document.getElementById('app');
if (!container) throw Error('Missing browser fixture container');

let state = { ...STARTER_STATE };
let source = STARTER_SCENE;
const actions = [];
let sceneError = null;
const draw = () =>
  renderConfined(
    h(
      'div',
      { class: 'whylip-layout' },
      h(
        'header',
        { class: 'whylip-toolbar' },
        h(
          'div',
          { class: 'whylip-brand' },
          h('span', { class: 'whylip-title' }, 'whylip'),
          h('span', { class: 'whylip-edition' }, 'a living storybook'),
        ),
        h('span', { class: 'whylip-status' }, 'The book is listening'),
      ),
      h(
        'main',
        { class: 'whylip-main' },
        h(SceneCanvas, {
          source,
          state,
          onState: patch => {
            state = { ...state, ...patch };
            draw();
          },
          onAction: (name, detail) => actions.push({ name, detail }),
          onError: error => {
            sceneError = error;
          },
        }),
      ),
    ),
    container,
  );

globalThis.__whylip = {
  actions,
  getState: () => state,
  getError: () => sceneError,
  patchState: patch => {
    state = { ...state, ...patch };
    draw();
  },
  edit: () => {
    source = STARTER_SCENE.replace(
      'At the edge of a very ordinary evening,',
      'On this newly written page,',
    );
    draw();
  },
  breakSource: () => {
    source = '({ h }';
    draw();
  },
  restore: () => {
    source = STARTER_SCENE;
    draw();
  },
};
draw();
globalThis.__ready = true;
