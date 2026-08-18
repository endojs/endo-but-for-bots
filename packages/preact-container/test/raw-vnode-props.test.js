// raw-vnode-props.test.js — the host-side seam of `confineComponent`.
//
// Only `children` is transcluded opaquely. Any OTHER prop is passed to the guest as-is, so a vnode
// in one of those props reaches the guest raw: `props.header.type` is a live host component
// function the guest can call with arguments of its choosing. That is a host MISTAKE (the host
// handed it over), but it wears the shape of ordinary Preact (`h(Confined, { header: h(...) })`),
// so the seam fails fast instead of degrading quietly — same policy as the renderer's
// mounted-outside-renderConfined throw.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent } from '../src/compartment.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('confineComponent — raw host vnodes must not cross as props', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  const HostHeader = () => h('h1', null, 'host header');

  it('throws when the host passes a vnode in a non-children prop', () => {
    const Child = confineComponent(({ h: ch }) => ch('div', null, 'guest'));
    expect(() =>
      renderConfined(h(Child, { header: h(HostHeader, null) }), scratch),
    ).to.throw(TypeError, /raw.*vnode/i);
  });

  it('throws when a vnode hides inside an array prop', () => {
    const Child = confineComponent(({ h: ch }) => ch('div', null, 'guest'));
    expect(() =>
      renderConfined(
        h(Child, { items: ['plain', h('li', null, 'host item')] }),
        scratch,
      ),
    ).to.throw(TypeError, /raw.*vnode/i);
  });

  it('host children still cross — as opaque sentinels, not a rejection', () => {
    const Child = confineComponent(({ h: ch }, props) =>
      ch('div', null, 'around:', props.children),
    );
    renderConfined(h(Child, null, h('span', null, 'transcluded')), scratch);
    expect(scratch.textContent).to.contain('around:');
    expect(scratch.textContent).to.contain('transcluded');
  });

  it('a confined component crosses as a prop — the supported carrier for host content', () => {
    const Badge = confineComponent(({ h: ch }) => ch('span', null, 'badge-ok'));
    const Child = confineComponent(({ h: ch }, props) =>
      ch('div', null, ch(props.Badge, null)),
    );
    renderConfined(h(Child, { Badge }), scratch);
    expect(scratch.textContent).to.contain('badge-ok');
  });

  it('function props still cross — a callback is a deliberate capability grant', () => {
    const pings = [];
    const onPing = payload => pings.push(payload);
    const Child = confineComponent(({ h: ch }, props) => {
      props.onPing('from-guest');
      return ch('div', null, 'guest');
    });
    renderConfined(h(Child, { onPing }), scratch);
    expect(pings).to.deep.equal(['from-guest']);
  });

  it('plain data props are untouched — including null-prototype bags', () => {
    let got = null;
    const bag = Object.create(null);
    bag.label = 'data';
    const Child = confineComponent(({ h: ch }, props) => {
      got = props.meta;
      return ch('div', null, String(props.meta.label));
    });
    renderConfined(h(Child, { meta: bag }), scratch);
    expect(got).to.equal(bag);
    expect(scratch.textContent).to.contain('data');
  });

  it('the sanitizer state recovers after the throw — a later render is unaffected', () => {
    const Child = confineComponent(({ h: ch }) => ch('div', null, 'guest'));
    expect(() =>
      renderConfined(h(Child, { header: h(HostHeader, null) }), scratch),
    ).to.throw(TypeError);
    const second = setupScratch();
    try {
      const Ok = confineComponent(({ h: ch }) => ch('em', null, 'recovered'));
      renderConfined(h(Ok, null), second);
      expect(second.textContent).to.contain('recovered');
    } finally {
      unmount(second);
      teardown(second);
    }
  });
});
