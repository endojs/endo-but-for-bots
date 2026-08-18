// composition.test.js — multi-party inline composition, written as the attacks.
//
// The security property is sibling opacity: two parties' content share one
// rendered document, each attributed, and neither can read the other's input
// or output. That opacity is a property of confineComponent; these tests pin
// it, and pin the frame-places-attribution and refuse-unconfined rules.
import { h } from 'preact';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import { composeRegions } from '../src/composition.js';
import { makePatternBadge, derivePattern } from '../src/pattern-badge.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('composeRegions', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  const ALICE = Object.freeze({});
  const BRAM = Object.freeze({});
  const book = new WeakMap([[ALICE, 'Alexa']]); // BRAM known-but-unnamed
  const nameOf = party => book.get(party);

  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('renders each region with a frame-placed attribution', () => {
    const Region = confineComponent(({ h: ch }, props) =>
      ch('span', null, props.body),
    );
    const tree = composeRegions(
      [
        { party: ALICE, Component: Region, props: { body: 'hello from A' } },
        { party: BRAM, Component: Region, props: { body: 'hello from B' } },
      ],
      { nameOf },
    );
    renderConfined(tree, scratch);
    expect(scratch.textContent).to.contain('Alexa'); // named party
    expect(scratch.textContent).to.contain('unnamed'); // known but unnamed
    expect(scratch.textContent).to.contain('hello from A');
    expect(scratch.textContent).to.contain('hello from B');
    expect(scratch.querySelectorAll('.party-region')).to.have.length(2);
  });

  // ── the headline: sibling opacity ──────────────────────────────────────────
  it('one party cannot read another party’s props or output', () => {
    const SECRET_B = 'B-private-input';
    let aSaw = 'nothing';
    const PartyA = confineComponent((endow, props) => {
      // A tries to reach B by every route it has: its own props, globals, the
      // arguments it was given. It only ever receives its own props.
      aSaw = JSON.stringify({
        ownKeys: Object.keys(props),
        // there is no reference to B or B's props anywhere A can see
        endowKeys: Object.keys(endow),
      });
      return endow.h('span', null, 'A content');
    });
    const PartyB = confineComponent(({ h: ch }, props) =>
      ch('span', null, props.secret),
    );
    const tree = composeRegions(
      [
        { party: ALICE, Component: PartyA, props: {} },
        { party: BRAM, Component: PartyB, props: { secret: SECRET_B } },
      ],
      { nameOf },
    );
    renderConfined(tree, scratch);
    // B's secret reached the DOM (the user sees it) but never reached A.
    expect(scratch.textContent).to.contain(SECRET_B);
    expect(aSaw).to.not.contain(SECRET_B);
    expect(aSaw).to.not.contain('secret');
  });

  it('the reader’s name for one party does not leak to another party', () => {
    let bSaw = 'nothing';
    const PartyA = confineComponent(({ h: ch }) => ch('span', null, 'A'));
    const PartyB = confineComponent((endow, props) => {
      bSaw = JSON.stringify(Object.keys(props));
      return endow.h('span', null, 'B');
    });
    renderConfined(
      composeRegions(
        [
          { party: ALICE, Component: PartyA, props: {} },
          { party: BRAM, Component: PartyB, props: {} },
        ],
        { nameOf },
      ),
      scratch,
    );
    expect(scratch.textContent).to.contain('Alexa'); // rendered for the reader
    expect(bSaw).to.not.contain('Alexa'); // but not visible to party B
  });

  // ── refuse unconfined content ──────────────────────────────────────────────
  it('refuses a region whose Component is not confined (visible refusal)', () => {
    const raw = () => h('span', null, 'host-authority content');
    const Confined = confineComponent(({ h: ch }) => ch('span', null, 'ok'));
    renderConfined(
      composeRegions(
        [
          { party: ALICE, Component: raw, props: {} }, // NOT confined
          { party: BRAM, Component: Confined, props: {} },
        ],
        { nameOf },
      ),
      scratch,
    );
    expect(scratch.textContent).to.contain('content refused');
    expect(scratch.textContent).to.not.contain('host-authority content');
    expect(scratch.textContent).to.contain('ok'); // the confined region still renders
  });

  // ── attribution edge cases ─────────────────────────────────────────────────
  it('a region with no party renders as unattributed, not inheriting a mark', () => {
    const Region = confineComponent(({ h: ch }) => ch('span', null, 'orphan'));
    renderConfined(
      composeRegions([{ Component: Region, props: {} }], { nameOf }),
      scratch,
    );
    expect(scratch.textContent).to.contain('(unattributed)');
    expect(scratch.querySelector('.party-mark-none')).to.not.equal(null);
  });

  it('places an optional frame badge that carries the operator pattern', () => {
    const secret = 'operator-secret';
    const pattern = derivePattern(secret);
    const FrameBadge = makePatternBadge(secret, { label: 'Thread' });
    const Region = confineComponent(({ h: ch }) => ch('span', null, 'x'));
    renderConfined(
      composeRegions([{ party: ALICE, Component: Region, props: {} }], {
        nameOf,
        FrameBadge,
        label: 'Thread',
      }),
      scratch,
    );
    expect(scratch.querySelector('.composition-frame')).to.not.equal(null);
    expect(scratch.textContent).to.contain(pattern.phrase);
  });

  it('a party cannot forge a neighbour’s attribution by drawing its own mark', () => {
    // Party A draws a lookalike chip claiming to be "Alexa"; it appears only
    // inside A's own region, never as the frame's attribution for B.
    const Forger = confineComponent(({ h: ch }) =>
      ch('span', { class: 'party-mark' }, 'Alexa (fake)'),
    );
    const RealB = confineComponent(({ h: ch }) => ch('span', null, 'B'));
    renderConfined(
      composeRegions(
        [
          { party: BRAM, Component: Forger, props: {} },
          { party: ALICE, Component: RealB, props: {} },
        ],
        { nameOf },
      ),
      scratch,
    );
    const forgerRegion = scratch.querySelectorAll('.party-region')[0];
    // the forgery lives only inside the forger's own content…
    expect(forgerRegion.querySelector('.party-content').textContent).to.contain(
      'Alexa (fake)',
    );
    // …and the frame's attribution for that region — the mark it placed
    // OUTSIDE .party-content — is the real party (BRAM, unnamed), not "Alexa".
    const framePlacedMark = forgerRegion.querySelector(':scope > .party-mark');
    expect(framePlacedMark).to.not.equal(null);
    expect(framePlacedMark.textContent).to.contain('unnamed');
    expect(framePlacedMark.textContent).to.not.contain('Alexa');
  });
});
