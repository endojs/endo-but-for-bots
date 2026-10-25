// @ts-check

import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { setupRerender } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { confineComponent } from '../src/compartment.js';
import { HostPassthrough, renderConfined, unmount } from '../src/renderer.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('trusted canvas beside confined overlays', () => {
  /** @type {HTMLDivElement} */
  let scratch;

  beforeEach(() => {
    scratch = setupScratch();
  });

  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('retains the host canvas and its resource lifetime across scene updates', () => {
    /** @type {HTMLCanvasElement | null} */
    let hostCanvas = null;
    let mounts = 0;
    let disposals = 0;
    const applied = [];

    /** @param {{color: string}} props */
    function TrustedCanvas({ color }) {
      const ref = useRef(/** @type {HTMLCanvasElement | null} */ (null));
      useLayoutEffect(() => {
        hostCanvas = ref.current;
        mounts += 1;
        return () => {
          disposals += 1;
        };
      }, []);
      useLayoutEffect(() => {
        // Stand-in for a persistent renderer's graph reconciliation. Only
        // trusted code receives the context, just as with a WebGL renderer.
        const context = ref.current?.getContext('2d');
        if (!context) throw Error('Host canvas context was not available');
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        applied.push(color);
      }, [color]);
      return h('canvas', { ref, width: 1, height: 1 });
    }
    const Overlay = confineComponent(({ h: create }) =>
      create('input', { value: 'First scene' }),
    );
    /** @param {{color: string}} props */
    function App({ color }) {
      return h(
        'section',
        null,
        h(HostPassthrough, null, h(TrustedCanvas, { color })),
        h(Overlay, null),
      );
    }
    renderConfined(h(App, { color: '#ff0000' }), scratch);
    const originalCanvas = scratch.querySelector('canvas');
    const input = scratch.querySelector('input');
    if (!originalCanvas || !input) throw Error('Expected canvas and input');
    input.focus();
    input.setSelectionRange(2, 2);

    renderConfined(h(App, { color: '#0000ff' }), scratch);

    expect(hostCanvas).to.equal(originalCanvas);
    expect(scratch.querySelector('canvas')).to.equal(originalCanvas);
    expect(mounts).to.equal(1);
    expect(disposals).to.equal(0);
    expect(applied).to.deep.equal(['#ff0000', '#0000ff']);
    expect(document.activeElement).to.equal(input);
    expect(input.selectionStart).to.equal(2);
    const context = originalCanvas.getContext('2d');
    if (!context) throw Error('Expected canvas context');
    expect(Array.from(context.getImageData(0, 0, 1, 1).data)).to.deep.equal([
      0, 0, 255, 255,
    ]);

    unmount(scratch);
    expect(disposals).to.equal(1);
  });

  it('keeps guest refs and events confined beside a host canvas', () => {
    let hostRefCalls = 0;
    let guestRefCalls = 0;
    /** @type {any} */
    let guestEvent;
    /** @type {any} */
    let guestEndowments;
    function TrustedCanvas() {
      return h('canvas', {
        ref: element => {
          if (element) hostRefCalls += 1;
        },
      });
    }
    const Guest = confineComponent(endowments => {
      guestEndowments = endowments;
      const { h: create } = endowments;
      return create(
        'div',
        null,
        create('canvas', {
          ref: () => {
            guestRefCalls += 1;
          },
        }),
        create('script', null, 'window.escaped = true'),
        create(
          'button',
          {
            ref: () => {
              guestRefCalls += 1;
            },
            onClick: event => {
              guestEvent = event;
            },
          },
          'Choose',
        ),
      );
    });
    function App() {
      return h(
        'section',
        null,
        h(HostPassthrough, null, h(TrustedCanvas, null)),
        h(Guest, null),
      );
    }
    renderConfined(h(App, null), scratch);
    const button = scratch.querySelector('button');
    if (!button) throw Error('Expected guest button');
    button.click();
    expect(hostRefCalls).to.equal(1);
    expect(guestRefCalls).to.equal(0);
    expect(scratch.querySelectorAll('canvas').length).to.equal(1);
    expect(scratch.querySelector('script')).to.equal(null);
    expect(guestEvent instanceof Event).to.equal(false);
    expect(guestEvent.target instanceof Element).to.equal(false);
    expect(guestEvent.target.ownerDocument).to.equal(undefined);
    expect(guestEndowments.HostPassthrough).to.equal(undefined);
    expect(guestEndowments.THREE).to.equal(undefined);
  });

  it('preserves a nested trusted canvas when its component updates its own state', () => {
    const rerender = setupRerender();
    let update = () => {};
    let refCalls = 0;
    function TrustedCanvas() {
      const [visible, setVisible] = useState(false);
      update = () => setVisible(true);
      return h(
        'div',
        { hidden: !visible },
        h('canvas', {
          ref: element => {
            if (element) refCalls += 1;
          },
        }),
      );
    }
    function App() {
      return h(HostPassthrough, null, h(TrustedCanvas, null));
    }
    renderConfined(h(App, null), scratch);
    const canvas = scratch.querySelector('canvas');
    expect(canvas).to.exist;
    update();
    rerender();
    expect(scratch.querySelector('canvas')).to.equal(canvas);
    expect(refCalls).to.be.greaterThan(0);
  });

  it('keeps a nested confined component sanitized on its own state update', () => {
    const rerender = setupRerender();
    let update = () => {};
    let guestRefCalls = 0;
    const Guest = confineComponent(({ h: create, useState: state }) => {
      const [active, setActive] = state(false);
      update = () => setActive(true);
      return create(
        'div',
        null,
        create(
          'span',
          {
            ref: () => {
              guestRefCalls += 1;
            },
          },
          active ? 'updated' : 'initial',
        ),
        active ? create('script', null, 'window.escaped = true') : null,
        active
          ? create('canvas', {
              ref: () => {
                guestRefCalls += 1;
              },
            })
          : null,
      );
    });
    function TrustedWrapper() {
      return h('div', null, h(Guest, null));
    }
    renderConfined(h(HostPassthrough, null, h(TrustedWrapper, null)), scratch);
    update();
    rerender();
    expect(scratch.querySelector('span')?.textContent).to.equal('updated');
    expect(scratch.querySelector('script')).to.equal(null);
    expect(scratch.querySelector('canvas')).to.equal(null);
    expect(guestRefCalls).to.equal(0);
  });
});
