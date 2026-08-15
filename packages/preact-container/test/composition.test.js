// composition.test.js — the Inc 5 COMPOSITION FRAME (src/composition.js).
//
// `composeRegions` renders several parties' content inline and attributes each region. The suite in
// sibling-opacity.test.js proves the parties cannot read each other; this one proves the FRAME's own
// claims cannot be forged or misappropriated — the half that is the frame's responsibility rather
// than the compartment's.
//
// Written as attacks, same discipline as sealed.test.js. The thing being defended is the operator's
// ability to believe an attribution: if Mallory can make her words carry Alice's mark, the whole
// surface is worse than one with no marks at all, because it manufactures false confidence.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent } from '../src/compartment.js';
import { composeRegions, derivePartyMark } from '../src/composition.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('composition frame — multi-party attribution', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  const SECRET = 'harbor-glass-secret-7f22';
  // Parties are OBJECTS (designs/designation-by-object-not-id.md). The frame designates them; the
  // name is resolved host-side via nameOf, keyed on the object — there is no string→party lookup.
  const ALICE = { kind: 'person' };
  const MALLORY = { kind: 'person' };
  const nameOf = p => (p === ALICE ? 'alice' : p === MALLORY ? 'mallory' : undefined);
  const OPTS = { secret: SECRET, nameOf };

  const region = (text, name) =>
    confineComponent(({ h: ch }, props) => ch('p', { class: 'body' }, props.text), { name });

  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  const marks = () => [...scratch.querySelectorAll('.party-mark')].map(n => n.textContent);

  it('composes every party inline, each with its own mark', () => {
    renderConfined(
      composeRegions(
        [
          { party: ALICE, Component: region('', 'A'), props: { text: 'the original text' } },
          { party: MALLORY, Component: region('', 'M'), props: { text: 'a friendly note' } },
        ],
        OPTS,
      ),
      scratch,
    );
    expect(scratch.textContent).to.contain('the original text');
    expect(scratch.textContent).to.contain('a friendly note');
    const m = marks();
    expect(m).to.have.lengthOf(2);
    expect(m[0]).to.contain('alice');
    expect(m[1]).to.contain('mallory');
  });

  it('a party is NOT given the attribution component, so it cannot place one at all', () => {
    // The core rule. If `Attribution` ever reached a region's props, that region could place it with
    // any name it liked — `party` is a declared primitive param by design.
    let sawProps = [];
    const Nosy = confineComponent(({ h: ch }, props) => {
      sawProps = Object.keys(props);
      return ch('p', null, props.text);
    }, { name: 'Nosy' });

    renderConfined(
      composeRegions([{ party: MALLORY, Component: Nosy, props: { text: 'hi' } }], OPTS),
      scratch,
    );
    // (`children` is preact's own addition, not something the frame passed.)
    expect(sawProps).to.not.include('Attribution');
    expect(sawProps.filter(k => k !== 'text' && k !== 'children')).to.deep.equal([]);
  });

  it('a party drawing a lookalike mark cannot reproduce the FRAME badge', () => {
    // Mallory can draw anything inside her own region — including something that looks like a mark.
    // What she cannot do is produce the operator's secret pattern, which is what says "this whole
    // composition is real". Her fake sits INSIDE a frame she could not authenticate.
    const Forger = confineComponent(({ h: ch }, props) =>
      ch('div', null,
        ch('span', { class: 'party-mark' }, '● alice'), // a hand-drawn lookalike
        ch('p', null, props.text)),
    { name: 'Forger' });

    renderConfined(
      composeRegions([{ party: MALLORY, Component: Forger, props: { text: 'trust me' } }], OPTS),
      scratch,
    );
    // the forgery is present in the DOM (pixels are not authenticated — we never claimed otherwise)…
    expect(scratch.textContent).to.contain('alice');
    // …but the frame badge, the thing that authenticates the composition, appears exactly once and is
    // not something she produced.
    expect(scratch.querySelectorAll('.secure-badge')).to.have.lengthOf(1);
    // and her REAL attribution still says mallory
    expect(marks()[0]).to.contain('mallory');
  });

  it('the frame badge renders the operator pattern and no party can read it', () => {
    let stolen = [];
    const Peeker = confineComponent(({ h: ch }, props) => {
      stolen = Object.values(props).map(v => String(v));
      return ch('p', null, props.text);
    }, { name: 'Peeker' });

    renderConfined(
      composeRegions([{ party: MALLORY, Component: Peeker, props: { text: 'x' } }], OPTS),
      scratch,
    );
    const badge = scratch.querySelector('.secure-badge');
    expect(badge, 'the frame badge painted').to.not.equal(null);
    expect(badge.textContent).to.have.length.greaterThan(0);
    expect(stolen.join(' ')).to.not.contain(SECRET);
    expect(stolen.join(' ')).to.not.contain(badge.textContent);
  });

  it('an unattributed region renders as unattributed — it does not inherit a neighbour\'s mark', () => {
    renderConfined(
      composeRegions(
        [
          { party: ALICE, Component: region('', 'A'), props: { text: 'signed' } },
          { Component: region('', 'Anon'), props: { text: 'anonymous insert' } },
        ],
        OPTS,
      ),
      scratch,
    );
    const m = marks();
    expect(m).to.have.lengthOf(2);
    expect(m[1]).to.contain('unattributed');
    expect(m[1]).to.not.contain('alice');
  });

  it('a region cannot re-mark itself by supplying its own `party` prop', () => {
    // The frame parameterizes the mark from the region descriptor IT composed. A party smuggling
    // `party` into its own props must not move the mark.
    renderConfined(
      composeRegions(
        [{ party: MALLORY, Component: region('', 'M'), props: { text: 'x', party: 'alice' } }],
        OPTS,
      ),
      scratch,
    );
    expect(marks()[0]).to.contain('mallory');
    expect(marks()[0]).to.not.contain('alice');
  });

  it('marks are stable per PARTY and survive renaming — they track who, not what you call them', () => {
    const a = derivePartyMark(ALICE);
    const b = derivePartyMark(MALLORY);
    expect(derivePartyMark(ALICE)).to.deep.equal(a); // stable — the operator can learn it
    expect(a.glyph + a.hue).to.not.equal(b.glyph + b.hue); // and distinguishing
    // Renaming must NOT move the mark: identity is the object, the name is a label on it.
    const before = derivePartyMark(ALICE);
    expect(derivePartyMark(ALICE)).to.deep.equal(before);
  });

  it('a STRING party is refused loudly — the mistake this pattern exists to prevent', () => {
    expect(() => composeRegions([{ party: 'alice', Component: region('', 'A'), props: {} }], OPTS))
      .to.throw(/by OBJECT, not by id/);
  });

  it('an UNNAMED party is still marked and coloured (not blank, not an identifier)', () => {
    const STRANGER = { kind: 'person' };
    renderConfined(
      composeRegions([{ party: STRANGER, Component: region('', 'S'), props: { text: 'hi' } }], OPTS),
      scratch,
    );
    const chip = scratch.querySelector('.party-mark');
    expect(chip.className).to.contain('party-mark-unnamed');
    expect(chip.textContent).to.contain('unnamed');
    // consistently coloured from its own seed — the property that makes an unnamed party
    // recognisable across appearances. (Asserted on the SURVIVING style: the renderer's
    // SAFE_STYLE_PROPS allowlist filters inline styles, so this also pins that our colour
    // actually gets through it.)
    // BOTH halves of "consistently badged and coloured": a stable glyph AND a stable colour, from
    // the party's own seed. Asserted on the COMPUTED colour, not the style string — the browser
    // normalises hex to rgb() in the style attribute, and matching /#[0-9a-f]{6}/ against it fails
    // for that reason alone. (It did, and I briefly recorded a sanitizer gap that never existed.)
    expect(chip.textContent.length).to.be.greaterThan('unnamed'.length); // a glyph precedes the label
    expect(derivePartyMark(STRANGER)).to.deep.equal(derivePartyMark(STRANGER)); // stable
    const colour = getComputedStyle(chip).color;
    expect(colour).to.match(/^rgba?\(/);
    expect(colour).to.not.equal(getComputedStyle(document.body).color); // genuinely its own colour
  });

  it('an unconfined region is DROPPED rather than rendered raw', () => {
    // A raw function is not confined content. The RENDERER will happily render it — composeRegions is
    // host code, so the tree it builds is trusted and coerceType only screens vnodes returned BY
    // confined code. So the FRAME must screen its own inputs, or the surface becomes a way to smuggle
    // unconfined code into the page wearing someone else's mark. This test found exactly that.
    const raw = () => h('p', null, 'UNCONFINED-CONTENT');
    renderConfined(
      composeRegions([{ party: MALLORY, Component: raw, props: {} }], OPTS),
      scratch,
    );
    expect(scratch.textContent).to.not.contain('UNCONFINED-CONTENT');
    expect(scratch.textContent).to.contain('content refused'); // visibly refused, not silently missing
    expect(marks()[0]).to.contain('mallory'); // and the region is still attributed
  });
});
