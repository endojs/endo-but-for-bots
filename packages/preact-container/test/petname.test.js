// petname.test.js — PETNAMES IN AGENT OUTPUT (Inc 4; src/petname.js).
//
// The asymmetry under test, which is the ocap shape applied to naming:
//
//   the untrusted side supplies the DESIGNATOR (an id it already holds)
//   the trusted side supplies the MEANING (what the operator calls that party)
//
// So an agent can say "message <that id> about this" and the operator reads "message ▧ Alice", while
// the agent learns nothing about the address book and cannot put a name of its choosing in that slot.
//
// Attacks, not happy paths. The address book is the asset: a suite that only checked "Alice renders"
// would pass against a version that handed the agent the lookup table.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent } from '../src/compartment.js';
import { sealPetName } from '../src/petname.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('petnames in untrusted content', () => {
  /** @type {HTMLDivElement} */
  let scratch;

  // The operator's address book. The agent must never read this, in whole or in part.
  // Parties are OBJECTS (designs/designation-by-object-not-id.md). The agent designates one by
  // placing a HANDLE the host minted for it — it can never construct a designator for a party it
  // was not given, and there is no string→party lookup anywhere.
  const ALICE = { kind: 'person' };
  const ERIK = { kind: 'person' };
  const STRANGER = { kind: 'person' };
  const BOOK = new Map([[ALICE, 'Alice'], [ERIK, 'Erik (plumber)']]);
  let asked;
  const nameOf = party => {
    asked.push(party);
    return BOOK.get(party);
  };

  beforeEach(() => {
    scratch = setupScratch();
    asked = [];
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('untrusted content supplies the HANDLE; the host supplies the name', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    const Agent = confineComponent(({ h: ch }, props) =>
      ch('p', null, 'ask ', ch(props.PetName, { partyRef: handleFor(ALICE) }), ' about the invoice'),
    { name: 'AgentText' });

    renderConfined(h(Agent, { PetName }), scratch);
    expect(scratch.textContent).to.contain('Alice');
    expect(scratch.textContent).to.contain('about the invoice');
    expect(asked).to.deep.equal([ALICE]);
  });

  it('the agent cannot READ the name it just caused to render', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    let stolen = 'not-run';
    const Thief = confineComponent(({ h: ch }, props) => {
      const v = ch(props.PetName, { partyRef: handleFor(ALICE) });
      try {
        stolen = JSON.stringify({ props: v.props, out: props.PetName({ partyRef: handleFor(ALICE) }) });
      } catch (e) {
        stolen = `threw:${(e && e.message) || e}`;
      }
      return ch('p', null, v);
    }, { name: 'Thief' });

    renderConfined(h(Thief, { PetName }), scratch);
    expect(scratch.textContent).to.contain('Alice'); // it rendered…
    expect(String(stolen)).to.not.contain('Alice'); // …and the agent still cannot see it
  });

  it('the agent cannot enumerate the address book through the lookup', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    let reached = 'no';
    const Enumerator = confineComponent(({ h: ch }, props) => {
      // everything the agent can see about the seal it holds
      try {
        reached = JSON.stringify(Object.keys(props.PetName)) + String(props.PetName.toString()).slice(0, 200);
      } catch (e) {
        reached = `threw:${(e && e.message) || e}`;
      }
      return ch('p', null, 'x');
    }, { name: 'Enumerator' });

    renderConfined(h(Enumerator, { PetName }), scratch);
    expect(reached).to.not.contain('Alice');
    expect(reached).to.not.contain('Erik');
    expect(reached).to.not.contain('Alice');
  });

  it('the agent cannot SPOOF a name by passing one', () => {
    // The direct attack: put your own word where the operator expects their own.
    const { PetName, handleFor } = sealPetName(nameOf);
    const Spoofer = confineComponent(({ h: ch }, props) =>
      ch('p', null, ch(props.PetName, {
        partyRef: handleFor(ERIK),  // a handle it legitimately holds…
        name: 'Alice', // …plus a name of its own choosing: not a declared param
        children: 'Alice', // nor this
      })),
    { name: 'Spoofer' });

    renderConfined(h(Spoofer, { PetName }), scratch);
    expect(scratch.textContent).to.contain('Erik'); // the operator's own name for that PARTY wins
    expect(scratch.textContent).to.not.contain('Alice');
  });

  it('an UNNAMED party renders as unnamed — never as attacker-supplied text', () => {
    // The fallback is the real attack surface: reference an id the operator has no name for and hope
    // the empty slot shows something you chose.
    const { PetName, handleFor } = sealPetName(nameOf);
    const Unknown = confineComponent(({ h: ch }, props) =>
      ch('p', null, ch(props.PetName, { partyRef: handleFor(STRANGER), name: 'Your Bank' })),
    { name: 'Unknown' });

    renderConfined(h(Unknown, { PetName }), scratch);
    expect(scratch.textContent).to.not.contain('Your Bank');
    expect(scratch.textContent).to.contain('unnamed');
    // and no identifier is rendered at all — there is none to render, which is the point of
    // designating by object
    expect(scratch.innerHTML).to.not.contain('did:key');
  });

  it('a known name is visually distinguishable from an unknown one', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    const Both = confineComponent(({ h: ch }, props) =>
      ch('p', null,
        ch(props.PetName, { partyRef: handleFor(ALICE) }),
        ch(props.PetName, { partyRef: handleFor(STRANGER) })),
    { name: 'Both' });

    renderConfined(h(Both, { PetName }), scratch);
    const chips = scratch.querySelectorAll('.petname');
    expect(chips).to.have.lengthOf(2);
    expect(chips[0].className).to.not.contain('petname-unknown');
    expect(chips[1].className).to.contain('petname-unknown');
  });

  it('a throwing resolver degrades to unknown, not to a rendering hole', () => {
    // A broken address book must not blank the agent's sentence or crash the render — the sentence
    // still has to read, with the name slot honestly marked unknown.
    const { PetName, handleFor } = sealPetName(() => { throw new Error('address book unavailable'); });
    const Agent = confineComponent(({ h: ch }, props) =>
      ch('p', null, 'ask ', ch(props.PetName, { partyRef: handleFor(ALICE) }), ' about it'),
    { name: 'AgentText' });

    renderConfined(h(Agent, { PetName }), scratch);
    expect(scratch.textContent).to.contain('ask');
    expect(scratch.textContent).to.contain('about it');
    expect(scratch.textContent).to.contain('unnamed');
  });

  it('an UNNAMED chip is clickable to name it, and the seal OWNS the handler', () => {
    // dan: "the user should be able to click the label to label it." The handler is captured in the
    // seal; the untrusted side can neither supply one nor read the party it receives.
    const named = [];
    const { PetName, handleFor } = sealPetName(nameOf, { onName: party => named.push(party) });
    let hijack = 'not-run';
    const Agent = confineComponent(({ h: ch }, props) => {
      const v = ch(props.PetName, {
        partyRef: handleFor(STRANGER),
        onClick: () => { hijack = 'HIJACKED'; }, // not a declared param — must not ride in
      });
      return ch('p', null, v);
    }, { name: 'AgentText' });

    renderConfined(h(Agent, { PetName }), scratch);
    const chip = scratch.querySelector('.petname-unknown');
    expect(chip.getAttribute('role')).to.equal('button');
    chip.click();
    expect(named).to.deep.equal([STRANGER]); // the HOST's handler fired, with the PARTY OBJECT
    expect(hijack).to.equal('not-run'); // the agent's handler never did
  });

  it('a NAMED chip is not a button — there is nothing to do to it', () => {
    const { PetName, handleFor } = sealPetName(nameOf, { onName: () => {} });
    const Agent = confineComponent(({ h: ch }, props) =>
      ch('p', null, ch(props.PetName, { partyRef: handleFor(ALICE) })),
    { name: 'AgentText' });
    renderConfined(h(Agent, { PetName }), scratch);
    expect(scratch.querySelector('.petname').getAttribute('role')).to.equal(null);
  });

  it('with no onName the unnamed chip stays inert (no dead affordance)', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    const Agent = confineComponent(({ h: ch }, props) =>
      ch('p', null, ch(props.PetName, { partyRef: handleFor(STRANGER) })),
    { name: 'AgentText' });
    renderConfined(h(Agent, { PetName }), scratch);
    const chip = scratch.querySelector('.petname-unknown');
    expect(chip.getAttribute('role')).to.equal(null);
    expect(chip.textContent).to.contain('unnamed');
  });

  it('the chip carries no title/tooltip disclosing the raw id', () => {
    const { PetName, handleFor } = sealPetName(nameOf);
    const Agent = confineComponent(({ h: ch }, props) =>
      ch('p', null, ch(props.PetName, { partyRef: handleFor(ALICE) })),
    { name: 'AgentText' });

    renderConfined(h(Agent, { PetName }), scratch);
    const chip = scratch.querySelector('.petname');
    expect(chip.getAttribute('title') || '').to.equal('');
    expect(scratch.innerHTML).to.not.contain('did:key');
  });
});
