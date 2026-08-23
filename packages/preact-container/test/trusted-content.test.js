// trusted-content.test.js — a confined component as TRUSTED content a guest places but cannot read.
//
// A confined wrapper is a mutual-suspicion component boundary. The usual direction confines an
// untrusted guest; this file exercises the other direction: the host wraps its OWN function (a
// reader's private petname for a party) and hands the wrapper to an untrusted, confined guest. The
// guest may PLACE it but must not inspect it, invoke it for a value, or forge it. The motivating
// cases are all "render MY meaning of YOUR designator":
//
//   · a friend's petname beside a party the guest was handed, without the page learning or
//     spoofing it;
//   · a timestamp in the viewer's timezone, without disclosing the timezone;
//   · a security-critical confirmation rendered inside a less-trusted interaction.
//
// Every attack-shaped test is written as the ATTACK, because the value of this boundary is entirely
// in what a hostile guest CANNOT do.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Suspense } from 'preact/compat';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent, isConfinedComponent } from '../src/compartment.js';
import { setupScratch, teardown } from './_util/helpers.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('confineComponent as trusted content', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  // ── designation by reference: the parameter that names a thing IS the thing ────────────────────
  it('the guest designates a party by OBJECT — no global id, nothing to guess', () => {
    const ALICE = Object.freeze({});
    const names = new WeakMap();
    names.set(ALICE, 'Alexa');
    const PetName = confineComponent(({ h: ch }, { party }) =>
      ch('span', { class: 'pet' }, names.get(party) || 'unknown'),
    );
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(
        'div',
        null,
        'from ',
        ch(props.PetName, { party: props.author }),
        ' / forged: ',
        // A fabricated object is simply not in the host's WeakMap.
        ch(props.PetName, { party: { forged: true } }),
      ),
    );
    renderConfined(h(Guest, { PetName, author: ALICE }), scratch);
    expect(scratch.textContent).to.contain('Alexa');
    expect(scratch.textContent).to.contain('forged: unknown');
  });

  it('is recognized by IDENTITY, not by a flag an attacker can set', () => {
    const PetName = confineComponent(({ h: ch }) => ch('span', null, 'x'));
    expect(isConfinedComponent(PetName)).to.equal(true);
    const forged = () => h('span', null, 'Alexa');
    forged._isConfined = true;
    forged._isSecureExit = true;
    expect(isConfinedComponent(forged)).to.equal(false);
  });

  it('the wrapper is frozen — it cannot become a dropbox between parties', () => {
    const PetName = confineComponent(({ h: ch }) => ch('span', null, 'x'));
    expect(Object.isFrozen(PetName)).to.equal(true);
    // ESM is strict mode, so writing to a frozen object throws.
    expect(() => {
      PetName.__dropbox = 'secret';
    }).to.throw();
    expect(PetName.__dropbox).to.equal(undefined);
  });

  // ── the gate: CANNOT INVOKE FOR A VALUE ────────────────────────────────────────────────────────
  // The exfiltration move: the guest holds the wrapper (it is a prop) and calls it directly during
  // its own render, reading the rendered petname straight out of the returned vnode.
  it('calling the wrapper directly yields NOTHING (no rendered output as a value)', () => {
    const names = new WeakMap();
    const ALICE = Object.freeze({});
    names.set(ALICE, 'Alexa');
    const PetName = confineComponent(({ h: ch }, { party }) =>
      ch('span', null, names.get(party) || 'unknown'),
    );
    let stolen = 'not-run';
    const Thief = confineComponent(({ h: ch }, props) => {
      try {
        stolen = JSON.stringify(props.PetName({ party: props.author }));
      } catch (e) {
        stolen = `threw:${(e && e.message) || e}`;
      }
      return ch('div', null, 'x');
    });
    renderConfined(h(Thief, { PetName, author: ALICE }), scratch);
    expect(
      stolen === 'null' || stolen === undefined || /^threw:/.test(stolen),
    ).to.equal(true);
    expect(String(stolen)).to.not.contain('Alexa');
  });

  it('the rendered petname never reaches the guest as data (it only reaches the DOM)', () => {
    const names = new WeakMap();
    const ALICE = Object.freeze({});
    names.set(ALICE, 'Alexa');
    const PetName = confineComponent(({ h: ch }, { party }) =>
      ch('span', null, names.get(party) || 'unknown'),
    );
    const seen = [];
    const Peeker = confineComponent(({ h: ch }, props) => {
      const vnode = ch(props.PetName, { party: props.author });
      // walk everything the guest can see about the vnode it just built
      seen.push(JSON.stringify(vnode.props || {}));
      seen.push(String(vnode.type && vnode.type.name));
      try {
        seen.push(JSON.stringify(vnode.type.toString()));
      } catch (e) {
        seen.push('toString-threw');
      }
      return ch('div', null, vnode);
    });
    renderConfined(h(Peeker, { PetName, author: ALICE }), scratch);
    expect(scratch.textContent).to.contain('Alexa'); // the USER sees it…
    expect(seen.join(' ')).to.not.contain('Alexa'); // …the guest never does
  });

  // ── props pass through: attacker-provided, validated by the trusted component ──────────────────
  it('all props reach the trusted component; the guest cannot read the output regardless', () => {
    let got = null;
    const Trusted = confineComponent(({ h: ch }, props) => {
      got = props;
      return ch('span', null, 'ok');
    });
    const guestFn = () => 'guest-capability';
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.T, { id: 'plain', onPoke: guestFn }),
    );
    renderConfined(h(Guest, { T: Trusted }), scratch);
    expect(got.id).to.equal('plain');
    // props pass through by reference — the trusted component validates them itself.
    expect(typeof got.onPoke).to.equal('function');
    expect(scratch.textContent).to.contain('ok');
  });

  it('validation composes over the trusted function (withPrimitiveProps)', () => {
    const withPrimitiveProps = fn => (endow, props) => {
      for (const key of Object.keys(props)) {
        // `confineComponent` always injects a `children` key (opaque
        // sentinels, or undefined when none) — a props validator must
        // account for it. Nullish is treated as absent.
        if (key === 'children') continue;
        const v = props[key];
        if (v == null) continue;
        const t = typeof v;
        if (
          t !== 'string' &&
          t !== 'number' &&
          t !== 'boolean' &&
          t !== 'bigint'
        ) {
          throw new TypeError(`unexpected non-primitive prop ${key}`);
        }
      }
      return fn(endow, props);
    };
    const Stamp = confineComponent(
      withPrimitiveProps(({ h: ch }, { label }) =>
        ch('span', null, `s:${label}`),
      ),
      { onError: () => {} },
    );
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(
        'div',
        null,
        ch(props.Stamp, { label: 'good' }),
        ch(props.Stamp, { label: 'bad', payload: { smuggle: true } }),
        'after',
      ),
    );
    expect(() => renderConfined(h(Guest, { Stamp }), scratch)).to.not.throw();
    expect(scratch.textContent).to.contain('s:good');
    expect(scratch.textContent).to.not.contain('s:bad');
    expect(scratch.textContent).to.contain('after');
  });

  // ── robustness ─────────────────────────────────────────────────────────────────────────────────
  it('a throwing trusted component renders nothing and does not take down the host', () => {
    const Boom = confineComponent(
      () => {
        throw new Error('trusted blew up');
      },
      { onError: () => {} },
    );
    const Guest = confineComponent(({ h: ch }, props) =>
      ch('div', null, 'before', ch(props.B, null), 'after'),
    );
    expect(() => renderConfined(h(Guest, { B: Boom }), scratch)).to.not.throw();
    expect(scratch.textContent).to.contain('before');
    expect(scratch.textContent).to.contain('after');
  });

  it('two trusted components are distinct: holding one does not let the guest place the other', () => {
    const A = confineComponent(({ h: ch }) => ch('span', null, 'AAA'));
    const B = confineComponent(({ h: ch }) => ch('span', null, 'BBB'));
    // the guest is given ONLY A, and tries to reach B by every route it has
    const Guest = confineComponent(({ h: ch }, props) => {
      const stolen = props.A.B || props.A.fn || props.A.inner;
      return ch(
        'div',
        null,
        ch(props.A, null),
        stolen ? ch(stolen, null) : 'no-B',
      );
    });
    renderConfined(h(Guest, { A }), scratch);
    expect(scratch.textContent).to.contain('AAA');
    expect(scratch.textContent).to.contain('no-B');
    expect(scratch.textContent).to.not.contain('BBB');
    expect(B).to.not.equal(A);
  });

  // ── the gate must not break normal confined rendering ──────────────────────────────────────────
  it('a confined component that setState-during-render still renders under the gate', () => {
    // setState during render drives Preact's do-while loop, which re-invokes the component. The gate
    // is armed per invocation by the __r hook; this pins that it re-arms across those iterations.
    const Counter = confineComponent(({ h: ch }) => {
      const [n, setN] = useState(0);
      if (n < 2) setN(n + 1);
      return ch('div', { class: 'count' }, `n=${n}`);
    });
    renderConfined(h(Counter, null), scratch);
    expect(scratch.querySelector('.count').textContent).to.equal('n=2');
  });

  it('a plain (non-confined) function passed as a component type is neutralized to a Fragment', () => {
    // A guest that somehow holds a plain host function cannot render it — coerceType turns any
    // non-identity function type into a Fragment (its children still render).
    const names = new WeakMap();
    const ALICE = Object.freeze({});
    names.set(ALICE, 'Alexa');
    const Plain = _props => h('span', null, 'Alexa'); // NOT confined
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(
        'div',
        { class: 'out' },
        ch(props.Plain, { party: props.author }, 'kid'),
      ),
    );
    renderConfined(h(Guest, { Plain, author: ALICE }), scratch);
    // Plain never ran; only its children survive (as a Fragment), so no 'Alexa'.
    expect(scratch.querySelector('.out').textContent).to.not.contain('Alexa');
  });
});

// The point of a mutual-suspicion boundary is that BOTH directions hold at
// once: in a single render, the guest's own output is confined (host is
// protected) AND the trusted content it places is unreadable to it (the
// trusted party is protected). These tests exercise both simultaneously.
describe('confineComponent — both directions in one render', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('confines the guest AND carries unreadable trusted content, together', () => {
    const ALICE = Object.freeze({});
    const names = new WeakMap();
    names.set(ALICE, 'Alexa');
    const PetName = confineComponent(({ h: ch }, { party }) =>
      ch('span', { class: 'pet' }, names.get(party) || 'unknown'),
    );

    let peeked = 'none';
    const Guest = confineComponent(({ h: ch }, props) => {
      // protect-the-trusted-party direction: place the badge, try to read it
      const badge = ch(props.PetName, { party: props.author });
      try {
        peeked = JSON.stringify(badge.props || {});
      } catch (e) {
        peeked = `threw:${e && e.message}`;
      }
      // protect-the-host direction: attempt injections that must be neutralized
      return ch(
        'div',
        { class: 'guest' },
        badge,
        ch(
          'a',
          { class: 'evil', href: 'javascript:globalThis.pwned = 1' },
          'x',
        ),
        ch('script', null, 'globalThis.pwned = 1'),
      );
    });

    delete globalThis.pwned;
    renderConfined(h(Guest, { PetName, author: ALICE }), scratch);

    // trusted content rendered for the user…
    expect(scratch.querySelector('.pet').textContent).to.equal('Alexa');
    // …but the guest never saw the name (only the opaque party ref it passed)
    expect(peeked).to.not.contain('Alexa');
    // guest injections neutralized: javascript: href dropped, <script> gone
    const a = scratch.querySelector('a.evil');
    expect(a).to.not.equal(null);
    expect(a.getAttribute('href')).to.equal(null);
    expect(scratch.querySelector('script')).to.equal(null);
    expect(globalThis.pwned).to.equal(undefined);
    delete globalThis.pwned;
  });

  it('a guest cannot read a trusted component even while its own output is being sanitized', () => {
    // The guest wraps the trusted badge in a disallowed tag (dropped to a
    // Fragment) — the sanitizer rewrites the guest subtree, yet the trusted
    // petname still renders and still never reaches the guest as data.
    const BOB = Object.freeze({});
    const names = new WeakMap();
    names.set(BOB, 'Bobby');
    const PetName = confineComponent(({ h: ch }, { party }) =>
      ch('span', { class: 'pet2' }, names.get(party) || 'unknown'),
    );
    let stolen = 'none';
    const Guest = confineComponent(({ h: ch }, props) => {
      try {
        // direct-call exfiltration attempt, mixed with a sanitized wrapper
        stolen = JSON.stringify(props.PetName({ party: props.author }));
      } catch (e) {
        stolen = `threw:${e && e.message}`;
      }
      return ch(
        'marquee', // disallowed tag → Fragment
        { class: 'evil2' },
        ch(props.PetName, { party: props.author }),
      );
    });
    renderConfined(h(Guest, { PetName, author: BOB }), scratch);
    expect(scratch.querySelector('.pet2').textContent).to.equal('Bobby');
    expect(scratch.querySelector('marquee')).to.equal(null); // wrapper dropped
    expect(String(stolen)).to.not.contain('Bobby'); // direct call yielded nothing
  });
});

// Suspense regression: the gate re-arms via Preact's __r hook before every
// component invocation, including re-invocations driven by a Suspense resume.
// This pins that a confined component is not spuriously nulled across a
// suspend/resume cycle. See the investigation in PR #1031.
describe('confineComponent — under Suspense', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('a confined component survives a sibling suspend/resume', async () => {
    const Confined = confineComponent(({ h: ch }) =>
      ch('div', { class: 'confined' }, 'confined-content'),
    );
    let resolve;
    const promise = new Promise(r => (resolve = r));
    let done = false;
    const Lazy = () => {
      if (!done) throw promise;
      return h('span', { class: 'lazy' }, 'lazy-loaded');
    };
    renderConfined(
      h(
        Suspense,
        { fallback: h('span', { class: 'fb' }, 'loading') },
        h(Confined, null),
        h(Lazy, null),
      ),
      scratch,
    );
    await tick();
    expect(scratch.querySelector('.fb')).to.not.equal(null); // suspended

    done = true;
    resolve();
    await tick(20);
    await tick(20);
    const el = scratch.querySelector('.confined');
    expect(el).to.not.equal(null);
    expect(el.textContent).to.equal('confined-content');
    expect(scratch.querySelector('.lazy').textContent).to.equal('lazy-loaded');
  });

  it('a confined component re-renders via setState after a Suspense resume', async () => {
    let bump;
    const Confined = confineComponent(({ h: ch }) => {
      const [n, setN] = useState(0);
      bump = () => setN(v => v + 1);
      return ch('div', { class: 'confined2' }, `n=${n}`);
    });
    let resolve;
    const promise = new Promise(r => (resolve = r));
    let done = false;
    const Lazy = () => {
      if (!done) throw promise;
      return h('span', null, 'ok');
    };
    renderConfined(
      h(
        Suspense,
        { fallback: h('span', null, 'loading') },
        h(Confined, null),
        h(Lazy, null),
      ),
      scratch,
    );
    await tick();
    done = true;
    resolve();
    await tick(20);
    bump();
    await tick(20);
    expect(scratch.querySelector('.confined2').textContent).to.equal('n=1');
  });
});
