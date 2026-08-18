// petname.test.js — "render my name for your party", written as the attacks.
import { h } from 'preact';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import { makePetName } from '../src/petname.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('makePetName', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  const ALICE = Object.freeze({});
  const BOB = Object.freeze({});
  const book = new WeakMap([[ALICE, 'Alexa']]); // BOB is known-to-no-name
  const nameOf = party => book.get(party);

  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('the guest places the chip by party OBJECT; the host supplies the name', () => {
    const PetName = makePetName(nameOf);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch('p', null, 'ping ', ch(props.PetName, { party: props.author })),
    );
    renderConfined(h(Guest, { PetName, author: ALICE }), scratch);
    expect(scratch.textContent).to.contain('Alexa');
  });

  it('a fabricated party object resolves to "unnamed", never guest text', () => {
    const PetName = makePetName(nameOf);
    const Guest = confineComponent(({ h: ch }) =>
      ch(PetName, { party: { forged: 'Mallory' } }),
    );
    renderConfined(h(Guest, { PetName }), scratch);
    expect(scratch.textContent).to.contain('unnamed');
    expect(scratch.textContent).to.not.contain('Mallory');
  });

  it('the guest cannot read the name by direct-calling the chip', () => {
    const PetName = makePetName(nameOf);
    let stolen = 'not-run';
    const Thief = confineComponent(({ h: ch }, props) => {
      try {
        stolen = JSON.stringify(props.PetName({ party: props.author }));
      } catch (e) {
        stolen = `threw:${e && e.message}`;
      }
      return ch('span', null, 'x');
    });
    renderConfined(h(Thief, { PetName, author: ALICE }), scratch);
    expect(String(stolen)).to.not.contain('Alexa');
  });

  it('the guest cannot restyle or hide the chip (withLimitedCss)', () => {
    const PetName = makePetName(nameOf);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.PetName, {
        party: props.author,
        style: 'display:none',
        class: 'attacker',
        className: 'attacker2',
      }),
    );
    renderConfined(h(Guest, { PetName, author: ALICE }), scratch);
    const chip = scratch.querySelector('.petname');
    expect(chip).to.not.equal(null);
    // guest style/class did not take effect: the chip keeps its own class and
    // its own inline style (no display:none smuggled in)
    expect(chip.className).to.equal('petname');
    expect(chip.getAttribute('style') || '').to.not.contain('display:none');
    expect(scratch.textContent).to.contain('Alexa');
  });

  it('a known party is marked with a stable glyph; the mark reaches the DOM', () => {
    const PetName = makePetName(nameOf);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.PetName, { party: props.author }),
    );
    renderConfined(h(Guest, { PetName, author: ALICE }), scratch);
    const chip = scratch.querySelector('.petname');
    // an aria-hidden glyph span precedes the name
    const glyphSpan = chip.querySelector('span[aria-hidden="true"]');
    expect(glyphSpan).to.not.equal(null);
    expect(glyphSpan.textContent.length).to.be.greaterThan(0);
  });

  it('an unnamed party with onName renders an activatable control the SEAL owns', () => {
    const named = [];
    const PetName = makePetName(nameOf, { onName: party => named.push(party) });
    const Guest = confineComponent(({ h: ch }, props) =>
      // BOB is a real party the host designated, but has no name yet
      ch(props.PetName, { party: props.who }),
    );
    renderConfined(h(Guest, { PetName, who: BOB }), scratch);
    const chip = scratch.querySelector('.petname-unknown');
    expect(chip).to.not.equal(null);
    expect(chip.getAttribute('role')).to.equal('button');
    chip.click();
    expect(named).to.deep.equal([BOB]); // handler received the party OBJECT
  });
});
