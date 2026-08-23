// raw-vnode-props.test.js — the raw-vnode seam of `confineComponent`.
//
// Only `children` is transcluded opaquely. A vnode in any OTHER prop would
// reach the receiver raw (`props.header.type` is a live, callable component),
// so the wrapper DROPS vnode-shaped non-children props. It drops rather than
// throws: a confined wrapper is used in both directions, and when a guest
// places trusted content it supplies that content's props — a throw there
// would be a guest-triggerable crash of the whole render. Dropping is safe
// either way and never crashes. This is a best-effort tripwire (top level plus
// one array level), not a boundary; carry host content as children or as a
// confined component.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent } from '../src/compartment.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('confineComponent — raw vnodes in non-children props are dropped', () => {
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

  it('drops a vnode passed in a non-children prop, without throwing', () => {
    let sawHeader = 'unset';
    const Child = confineComponent(({ h: ch }, props) => {
      sawHeader = props.header;
      return ch('div', null, 'guest');
    });
    expect(() =>
      renderConfined(h(Child, { header: h(HostHeader, null) }), scratch),
    ).to.not.throw();
    expect(sawHeader).to.equal(undefined); // the raw host vnode never reached the guest
    expect(scratch.textContent).to.contain('guest');
    expect(scratch.textContent).to.not.contain('host header');
  });

  it('drops a vnode hidden inside an array prop, without throwing', () => {
    let sawItems = 'unset';
    const Child = confineComponent(({ h: ch }, props) => {
      sawItems = props.items;
      return ch('div', null, 'guest');
    });
    expect(() =>
      renderConfined(
        h(Child, { items: ['plain', h('li', null, 'host item')] }),
        scratch,
      ),
    ).to.not.throw();
    expect(sawItems).to.equal(undefined);
    expect(scratch.textContent).to.not.contain('host item');
  });

  // The regression the drop-not-throw change fixes: a GUEST placing trusted
  // content and supplying a vnode-shaped prop must not crash the render.
  it('a guest placing trusted content with a vnode-shaped prop does not crash the render', () => {
    const names = new WeakMap();
    const ALICE = Object.freeze({});
    names.set(ALICE, 'Alexa');
    // trusted content the host wraps and hands to the guest
    const PetName = confineComponent(({ h: ch }, props) =>
      ch('span', null, names.get(props.party) || 'unknown'),
    );
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(
        'div',
        null,
        'from ',
        // guest supplies a hostile vnode-shaped prop alongside the designator
        ch(props.PetName, { party: props.author, evil: ch('span', null, 'x') }),
      ),
    );
    expect(() =>
      renderConfined(h(Guest, { PetName, author: ALICE }), scratch),
    ).to.not.throw();
    // the trusted content still renders; the render is intact, not blanked
    expect(scratch.textContent).to.contain('Alexa');
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

  it('the sanitizer state is unaffected by a dropped prop — a later render is normal', () => {
    const Child = confineComponent(({ h: ch }) => ch('div', null, 'guest'));
    renderConfined(h(Child, { header: h(HostHeader, null) }), scratch);
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
