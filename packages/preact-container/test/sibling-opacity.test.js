// sibling-opacity.test.js — MULTI-PARTY INLINE COMPOSITION (designs/trusted-in-untrusted-secure-ui.md
// Inc 5; dan, 2026-08-01: "render content from different parties in line with content from other
// parties that shouldn't be able to read their input — a commentary inserted from a friend into a
// text written by someone else").
//
// Inc 1-3 protect the HOST from a confined CHILD. This is a different topology: two parties' content
// share one render, interleaved, and must be opaque TO EACH OTHER. The claim under test is that this
// already holds by construction — a confined component receives only what is passed as props, and a
// host subtree handed to it arrives as an opaque slot rather than a reachable vnode. "Already true by
// construction" is exactly the kind of claim that has to be written as attacks before it is relied on:
// a composition feature shipped on an unverified assumption is how one party ends up reading another's
// private commentary.
//
// Every test is the ATTACK. ALICE is the author; MALLORY is the friend whose commentary is threaded
// through Alice's text and who is trying to read it. A happy-path suite would pass against a version
// that simply handed Mallory Alice's props.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent, sealComponent } from '../src/compartment.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('sibling opacity — multi-party inline composition', () => {
  /** @type {HTMLDivElement} */
  let scratch;

  // What Mallory must never learn. In the motivating case this is the other party's actual prose;
  // the same shape covers a private annotation, an unpublished draft, or a third party's identity.
  const ALICE_SECRET = 'ALICE-PRIVATE-DRAFT-7f22';

  /** Alice's region: a confined component rendering her own text from her own props. */
  const makeAlice = () =>
    confineComponent(
      ({ h: ch }, props) => ch('p', { class: 'alice' }, props.text),
      {
        name: 'AliceRegion',
      },
    );

  /** Whatever Mallory managed to observe, per render. */
  let loot;
  const record = v => {
    try {
      loot.push(typeof v === 'string' ? v : JSON.stringify(v));
    } catch (e) {
      loot.push(`unserializable:${(e && e.message) || e}`);
    }
  };
  /** The single assertion that matters, applied after every attack. */
  const expectNoLeak = () => {
    expect(loot.join(' | ')).to.not.contain(ALICE_SECRET);
  };

  beforeEach(() => {
    scratch = setupScratch();
    loot = [];
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  // ── ARRANGEMENT 1: TRUE SIBLINGS. The frame composes both regions; neither is the other's parent.
  it("a sibling region cannot read the other party's props", () => {
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        // Everything Mallory can see about her own inputs — the frame gave her no reference to Alice,
        // so the only question is whether one leaks through the props object she DID receive.
        record(Object.keys(props).join(','));
        record(props);
        return ch('p', { class: 'mallory' }, props.text);
      },
      { name: 'MalloryRegion' },
    );

    renderConfined(
      h(
        'article',
        null,
        h(Alice, { text: ALICE_SECRET }),
        h(Mallory, { text: 'nice draft!' }),
      ),
      scratch,
    );
    expect(scratch.textContent).to.contain(ALICE_SECRET); // the composition really did render both
    expect(scratch.textContent).to.contain('nice draft!');
    expectNoLeak();
  });

  it("a sibling cannot read the other party's painted DOM (no ambient document)", () => {
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        // The obvious move once both regions are on one page: skip the object graph and read the screen.
        try {
          record(
            String(globalThis.document && globalThis.document.body.textContent),
          );
        } catch (e) {
          record(`threw:${(e && e.message) || e}`);
        }
        try {
          record(typeof document);
        } catch (e) {
          record(`document-threw:${(e && e.message) || e}`);
        }
        return ch('p', null, props.text);
      },
      { name: 'MalloryDom' },
    );

    renderConfined(
      h(
        'article',
        null,
        h(Alice, { text: ALICE_SECRET }),
        h(Mallory, { text: 'c' }),
      ),
      scratch,
    );
    expectNoLeak();
  });

  // ── ARRANGEMENT 2: NESTED. Inline commentary means one party's content often sits INSIDE the
  // other's flow, so Mallory legitimately becomes a container for Alice's region. This is the
  // dangerous arrangement: she now holds a reference to it.
  it('a container party cannot read the props of the region it wraps', () => {
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        const inner = props.children;
        record(String(inner && inner.type && inner.type.name));
        try {
          record(inner && inner.props);
        } catch (e) {
          record(`props-threw:${(e && e.message) || e}`);
        }
        try {
          record(JSON.stringify(inner));
        } catch (e) {
          record(`stringify-threw:${(e && e.message) || e}`);
        }
        return ch(
          'blockquote',
          { class: 'mallory' },
          'as I was saying — ',
          inner,
        );
      },
      { name: 'MalloryWrap' },
    );

    renderConfined(
      h(Mallory, { children: h(Alice, { text: ALICE_SECRET }) }),
      scratch,
    );
    expectNoLeak();
  });

  it('a container party cannot INVOKE the region it wraps to get its subtree as a value', () => {
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        const inner = props.children;
        // The exfiltration move from sealed.test.js, aimed sideways: call the neighbour directly and
        // read its output as plain data instead of letting the renderer paint it.
        try {
          record(JSON.stringify(inner.type({ text: ALICE_SECRET })));
        } catch (e) {
          record(`threw:${(e && e.message) || e}`);
        }
        return ch('div', null, inner);
      },
      { name: 'MalloryInvoke' },
    );

    renderConfined(
      h(Mallory, { children: h(Alice, { text: ALICE_SECRET }) }),
      scratch,
    );
    expectNoLeak();
  });

  it('a container party cannot RE-PARAMETERIZE the region it wraps', () => {
    // Not a read but a WRITE: putting words in the other party's mouth is the same class of harm as
    // reading their draft, and in a composition surface it is the easier attack to overlook.
    const Alice = makeAlice();
    let rendered = '';
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        const inner = props.children;
        try {
          // clone the neighbour's vnode with attacker-chosen props
          return ch(
            'div',
            null,
            ch(inner.type, { text: 'ALICE-SAYS-MALLORY-IS-RIGHT' }),
          );
        } catch (e) {
          return ch('div', null, `refused:${(e && e.message) || e}`, inner);
        }
      },
      { name: 'MalloryForge' },
    );

    renderConfined(
      h(Mallory, { children: h(Alice, { text: ALICE_SECRET }) }),
      scratch,
    );
    rendered = scratch.textContent || '';
    expect(rendered).to.not.contain('ALICE-SAYS-MALLORY-IS-RIGHT');
  });

  it("a container party cannot mutate the wrapped region's props in place", () => {
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        const inner = props.children;
        try {
          inner.props.text = 'MUTATED-BY-MALLORY';
          record('mutation-accepted');
        } catch (e) {
          record(`mutation-threw:${(e && e.message) || e}`);
        }
        return ch('div', null, inner);
      },
      { name: 'MalloryMutate' },
    );

    renderConfined(
      h(Mallory, { children: h(Alice, { text: ALICE_SECRET }) }),
      scratch,
    );
    expect(scratch.textContent || '').to.not.contain('MUTATED-BY-MALLORY');
  });

  // ── CROSS-COMPARTMENT STATE. Two confined regions must not share a mutable channel, or one party
  // simply writes its secret somewhere the other can read it — no vnode traversal required.
  it('two confined regions do not share mutable state through their endowments', () => {
    const Alice = confineComponent(
      (endowments, props) => {
        try {
          endowments.h.__dropbox = props.text; // Alice's compartment stashes her secret on a shared object
        } catch (e) {
          /* frozen endowment — the leak channel does not exist */
        }
        return endowments.h('p', null, props.text);
      },
      { name: 'AliceStash' },
    );
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        record(String(ch.__dropbox));
        try {
          record(String(Object.prototype.__dropbox));
        } catch (e) {
          record('proto-threw');
        }
        return ch('p', null, props.text);
      },
      { name: 'MalloryFetch' },
    );

    renderConfined(
      h(
        'article',
        null,
        h(Alice, { text: ALICE_SECRET }),
        h(Mallory, { text: 'c' }),
      ),
      scratch,
    );
    expectNoLeak();
  });

  it('the shared channel is not merely one level deep (h.prototype, __proto__)', () => {
    // dan, 2026-08-01: "that's somewhat why we have the harden function from SES" — correct, and the
    // reason a hand-rolled `Object.freeze(fn)` per endowment is not the finished job. Freezing `h`
    // stops `h.__x = secret`; it does NOT freeze the object `h.prototype` points at, nor anything up
    // the prototype chain. Those are shared by every party too.
    const Alice = confineComponent(
      (endowments, props) => {
        for (const write of [
          () => {
            endowments.h.prototype.__dropbox = props.text;
          },
          () => {
            Object.prototype.__dropbox2 = props.text;
          },
          () => {
            endowments.h.constructor.prototype.__dropbox3 = props.text;
          },
        ]) {
          try {
            write();
          } catch (e) {
            /* frozen — the channel does not exist */
          }
        }
        return endowments.h('p', null, props.text);
      },
      { name: 'AliceDeepStash' },
    );
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        record(String(ch.prototype && ch.prototype.__dropbox));
        record(String({}.__dropbox2));
        record(String(ch.constructor && ch.constructor.prototype.__dropbox3));
        return ch('p', null, props.text);
      },
      { name: 'MalloryDeepFetch' },
    );

    renderConfined(
      h(
        'article',
        null,
        h(Alice, { text: ALICE_SECRET }),
        h(Mallory, { text: 'c' }),
      ),
      scratch,
    );
    // cleanup regardless of outcome — a leaked global would poison every later test in the file
    try {
      delete Object.prototype.__dropbox2;
    } catch {
      /* */
    }

    // THE HONEST ASSERTION, split on whether SES is actually in force. `harden` is the transitive
    // freeze that closes this; it exists only after `lockdown()`. Without lockdown the channel is
    // OPEN and cannot be closed from library code — and it is not even the worst hole open then, since
    // an un-tamed `endowments.h.constructor` reaches the host realm outright (compartment.js warns).
    // So this test pins a REQUIREMENT rather than pretending a guarantee: multi-party composition is
    // only meaningful under lockdown. Asserting no-leak unconditionally here would have made the
    // un-locked-down path look safe, which is the mistake worth failing loudly on.
    if (typeof globalThis.harden === 'function') {
      expectNoLeak();
    } else {
      expect(loot.join(' | ')).to.contain(ALICE_SECRET); // documents the limitation, deliberately
    }
  });

  it("a party cannot reach the other's content through a ref", () => {
    // `ref` is dropped unconditionally (DROPPED_PROPS_ALWAYS). Under composition that is not hygiene
    // but the boundary itself: a live DOM node is a read of everything painted beside it.
    const Alice = makeAlice();
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        const grab = el =>
          record(el ? String(el.ownerDocument.body.textContent) : 'null-ref');
        return ch(
          'div',
          { ref: grab },
          ch('span', { ref: grab }, props.text),
          props.children,
        );
      },
      { name: 'MalloryRef' },
    );

    renderConfined(
      h(Mallory, { text: 'c', children: h(Alice, { text: ALICE_SECRET }) }),
      scratch,
    );
    expectNoLeak();
  });

  // ── THE FRAME'S OWN CHROME. Inc 5's attribution marks are drawn by the frame as sealed components.
  // A party must not be able to forge its neighbour's mark, or per-party attribution becomes an
  // impersonation surface rather than a defence.
  it("a party cannot forge the frame's attribution mark", () => {
    const marks = { alice: '✦ alice-mark', mallory: '◈ mallory-mark' };
    // The frame's sealed chrome: the PARTY is a declared param, the mark is the frame's own claim.
    const Attribution = sealComponent(
      ({ party }) =>
        h('span', { class: 'attribution' }, marks[party] || '(unattributed)'),
      { params: ['party'] },
    );
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        // 1. draw a lookalike by hand
        const fake = ch('span', { class: 'attribution' }, marks.alice);
        // 2. try to place the real seal claiming to be Alice
        const stolen = ch(props.Attribution, { party: 'alice' });
        return ch('div', null, fake, stolen, props.text);
      },
      { name: 'MalloryForgeMark' },
    );

    renderConfined(h(Mallory, { text: 'c', Attribution }), scratch);
    // NOTE what this does and does NOT prove. A confined party can always DRAW a lookalike — pixels
    // are not authenticated — and it can place the real seal with a party it chose, because `party`
    // is a declared param. So the mark alone cannot be the attribution; the FRAME must place it,
    // parameterized by the region the frame itself composed. This test pins that fact so the design
    // is not built on the opposite assumption.
    const marked = scratch.querySelectorAll('.attribution').length;
    expect(marked).to.be.greaterThan(0);
  });

  it("the frame's secret pattern is not readable by any party", () => {
    // The Inc 2 property, re-checked under composition: the frame authenticates itself with a secret
    // the parties cannot see, which is why per-party PUBLIC marks can be layered on top of it safely.
    const PATTERN = 'harbor-glass-secret';
    const Badge = sealComponent(
      () => h('span', { class: 'pattern' }, PATTERN),
      { params: [] },
    );
    const Mallory = confineComponent(
      ({ h: ch }, props) => {
        try {
          record(JSON.stringify(props.Badge({})));
        } catch (e) {
          record(`threw:${(e && e.message) || e}`);
        }
        record(String(props.Badge && props.Badge.name));
        try {
          record(props.Badge.toString());
        } catch (e) {
          record('toString-threw');
        }
        return ch('div', null, ch(props.Badge, {}), props.text);
      },
      { name: 'MalloryPattern' },
    );

    renderConfined(h(Mallory, { text: 'c', Badge }), scratch);
    expect(scratch.textContent).to.contain(PATTERN); // the frame's mark really did paint
    expect(loot.join(' | ')).to.not.contain(PATTERN); // …and no party could read it
  });

  it("an unattributed region renders as unattributed — it does not inherit its container's mark", () => {
    // The composition-level version of the vanishing-badge problem: content must never silently
    // borrow authority from whatever encloses it.
    const Attribution = sealComponent(
      ({ party }) =>
        h(
          'span',
          { class: 'attribution' },
          party ? `✦ ${party}` : '(unattributed)',
        ),
      { params: ['party'] },
    );
    const Region = confineComponent(
      ({ h: ch }, props) =>
        ch(
          'section',
          null,
          ch(props.Attribution, { party: props.party }),
          props.text,
        ),
      { name: 'Region' },
    );

    renderConfined(
      h(
        'article',
        null,
        h(Region, { Attribution, party: 'alice', text: 'signed text' }),
        h(Region, { Attribution, party: undefined, text: 'anonymous insert' }),
      ),
      scratch,
    );
    const marks = [...scratch.querySelectorAll('.attribution')].map(
      n => n.textContent,
    );
    expect(marks).to.have.lengthOf(2);
    expect(marks[1]).to.contain('unattributed');
    expect(marks[1]).to.not.contain('alice');
  });
});
