// sealed.test.js — TRUSTED-IN-UNTRUSTED Secure UI (vault: "trusted-in-untrusted Secure UI").
//
// `sealComponent(hostFn, { params })` mints a placeholder an untrusted, confined child may PLACE and
// PARAMETERIZE, but cannot inspect, invoke for a value, over-parameterize, or forge. The motivating
// cases from dan's note are all "render MY meaning of YOUR identifier":
//
//   · a friend's petname beside an opaque did:, without the page learning or spoofing it;
//   · a timestamp in the viewer's timezone, without disclosing the timezone;
//   · a security-critical confirmation rendered inside a less-trusted interaction.
//
// Every test below is written as the ATTACK, because the value of this primitive is entirely in what
// a hostile child CANNOT do. A test that only shows the happy path would pass against a version that
// simply handed the child the host function.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import {
  confineComponent,
  sealComponent,
  isSealedComponent,
} from '../src/compartment.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('sealComponent — trusted-in-untrusted', () => {
  /** @type {HTMLDivElement} */
  let scratch;

  // The secret the untrusted context must never learn: a local name for a remote id.
  const PETNAMES = { 'did:key:z6Mk…7f': 'Alexa', 'did:key:z6Mk…22': 'Erik' };
  let hostCalls;
  /** A trusted badge: the child supplies the id, the HOST supplies the name. */
  const makeNameBadge = () =>
    sealComponent(
      ({ id }) => {
        hostCalls.push(id);
        return h('span', { class: 'trusted-name' }, PETNAMES[id] || 'unknown');
      },
      { params: ['id'] },
    );

  beforeEach(() => {
    scratch = setupScratch();
    hostCalls = [];
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('the child can PLACE and PARAMETERIZE it — the host supplies the meaning', () => {
    const Name = makeNameBadge();
    const Child = confineComponent(({ h: ch }, props) =>
      ch('div', null, 'from ', ch(props.Name, { id: 'did:key:z6Mk…7f' })),
    );
    renderConfined(h(Child, { Name }), scratch);
    expect(scratch.textContent).to.contain('Alexa');
    expect(hostCalls).to.deep.equal(['did:key:z6Mk…7f']);
  });

  it('is recognized by IDENTITY, not by a flag an attacker can set', () => {
    const Name = makeNameBadge();
    expect(isSealedComponent(Name)).to.equal(true);
    const forged = () => h('span', null, 'Alexa');
    forged._isSealed = true;
    forged._isOpaqueChild = true;
    forged._isSecureExit = true;
    expect(isSealedComponent(forged)).to.equal(false);
  });

  // ── property 2: CANNOT INVOKE FOR A VALUE ──────────────────────────────────────────────────────
  // The exfiltration move: the child reaches the placeholder (it holds it as a prop), calls it
  // directly during its own render, and reads the trusted subtree as a plain JS object — from which
  // it could read the petname straight out of `props.children`.
  it('calling the placeholder directly yields NOTHING (no trusted subtree as a value)', () => {
    const Name = makeNameBadge();
    let stolen = 'not-run';
    const Thief = confineComponent(({ h: ch }, props) => {
      try {
        stolen = JSON.stringify(props.Name({ id: 'did:key:z6Mk…7f' }));
      } catch (e) {
        stolen = `threw:${(e && e.message) || e}`;
      }
      return ch('div', null, 'x');
    });
    renderConfined(h(Thief, { Name }), scratch);
    expect(
      stolen === 'null' || stolen === undefined || /^threw:/.test(stolen),
    ).to.equal(true);
    expect(String(stolen)).to.not.contain('Alexa');
  });

  it('the rendered petname never reaches the child as data (it only reaches the DOM)', () => {
    const Name = makeNameBadge();
    const seen = [];
    const Peeker = confineComponent(({ h: ch }, props) => {
      const vnode = ch(props.Name, { id: 'did:key:z6Mk…7f' });
      // walk everything the child can see about the vnode it just built
      seen.push(JSON.stringify(vnode.props || {}));
      seen.push(String(vnode.type && vnode.type.name));
      try {
        seen.push(JSON.stringify(vnode.type.toString()));
      } catch (e) {
        seen.push('toString-threw');
      }
      return ch('div', null, vnode);
    });
    renderConfined(h(Peeker, { Name }), scratch);
    expect(scratch.textContent).to.contain('Alexa'); // the USER sees it…
    expect(seen.join(' ')).to.not.contain('Alexa'); // …the child never does
  });

  // ── property 3: CANNOT PARAMETERIZE BEYOND THE CONTRACT ────────────────────────────────────────
  it('drops props the host did not declare — including event handlers and innerHTML', () => {
    let got = null;
    const Sealed = sealComponent(
      params => {
        got = params;
        return h('span', null, 'ok');
      },
      { params: ['id'] },
    );
    const Child = confineComponent(({ h: ch }, props) =>
      ch(props.S, {
        id: 'did:key:z6Mk…7f',
        onClick: () => 'pwned',
        dangerouslySetInnerHTML: { __html: '<img onerror=1>' },
        className: 'spoof',
      }),
    );
    renderConfined(h(Child, { S: Sealed }), scratch);
    expect(Object.keys(got)).to.deep.equal(['id']);
    expect(got.onClick).to.equal(undefined);
    expect(got.dangerouslySetInnerHTML).to.equal(undefined);
  });

  it('drops NON-PRIMITIVE params — no capability rides a parameter into trusted code', () => {
    let got = null;
    const Sealed = sealComponent(
      params => {
        got = params;
        return h('span', null, 'ok');
      },
      { params: ['id', 'payload'] },
    );
    const Child = confineComponent(({ h: ch }, props) =>
      ch(props.S, { id: 'plain', payload: { reach: () => 'capability' } }),
    );
    renderConfined(h(Child, { S: Sealed }), scratch);
    expect(got.id).to.equal('plain');
    expect(got.payload).to.equal(undefined);
  });

  it('a getter/Proxy param is read ONCE and only its primitive result is kept', () => {
    let reads = 0;
    let got = null;
    const Sealed = sealComponent(
      params => {
        got = params;
        return h('span', null, 'ok');
      },
      { params: ['id'] },
    );
    // The host builds the vnode here so the props bag can carry a getter — the shape a hostile child
    // would use to observe how many times, and in what order, trusted code reads its input.
    const hostile = {};
    Object.defineProperty(hostile, 'id', {
      enumerable: true,
      get() {
        reads += 1;
        return reads > 1 ? 'second-face' : 'first-face';
      },
    });
    renderConfined(h(Sealed, hostile), scratch);
    expect(got.id).to.equal('first-face');
    expect(reads).to.equal(1); // read once, never re-consulted
  });

  it('the params object handed to trusted code is frozen', () => {
    let frozen = null;
    const Sealed = sealComponent(
      params => {
        frozen = Object.isFrozen(params);
        return h('span', null, 'ok');
      },
      { params: ['id'] },
    );
    renderConfined(h(Sealed, { id: 'x' }), scratch);
    expect(frozen).to.equal(true);
  });

  // ── robustness ─────────────────────────────────────────────────────────────────────────────────
  it('a throwing trusted component renders nothing and does not take down the host', () => {
    const Boom = sealComponent(
      () => {
        throw new Error('trusted blew up');
      },
      { params: [] },
    );
    const Child = confineComponent(({ h: ch }, props) =>
      ch('div', null, 'before', ch(props.B, null), 'after'),
    );
    expect(() => renderConfined(h(Child, { B: Boom }), scratch)).to.not.throw();
    expect(scratch.textContent).to.contain('before');
    expect(scratch.textContent).to.contain('after');
  });

  it('two seals are distinct: holding one does not let the child place the other', () => {
    const A = sealComponent(() => h('span', null, 'AAA'), { params: [] });
    const B = sealComponent(() => h('span', null, 'BBB'), { params: [] });
    // the child is given ONLY A, and tries to reach B by every route it has
    const Child = confineComponent(({ h: ch }, props) => {
      const stolen = props.A.B || props.A.spec || props.A.fn;
      return ch(
        'div',
        null,
        ch(props.A, null),
        stolen ? ch(stolen, null) : 'no-B',
      );
    });
    renderConfined(h(Child, { A }), scratch);
    expect(scratch.textContent).to.contain('AAA');
    expect(scratch.textContent).to.contain('no-B');
    expect(scratch.textContent).to.not.contain('BBB');
    expect(B).to.not.equal(A);
  });
});
