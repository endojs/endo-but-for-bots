// party-mark.test.js — designation by object, deterministic marks.
import { partyMark } from '../src/party-mark.js';

describe('partyMark', () => {
  it('is stable: the same object always yields the same mark', () => {
    const alice = {};
    const first = partyMark(alice);
    const second = partyMark(alice);
    expect(second).to.equal(first); // same frozen object
    expect(first.glyph).to.be.a('string');
    expect(first.color).to.match(/^#[0-9a-f]{6}$/);
  });

  it('distinguishes distinct parties (deterministic, no flaky collisions)', () => {
    // Deterministic first-seen assignment means the first N parties never
    // collide — no random-seed coin flip like the original approach.
    const parties = Array.from({ length: 8 }, () => ({}));
    const marks = parties.map(partyMark);
    const keys = new Set(marks.map(m => `${m.glyph}|${m.color}`));
    expect(keys.size).to.equal(parties.length);
  });

  it('does not change a mark when a party is later named elsewhere', () => {
    // The mark tracks WHO (the object), not what it is called — naming is a
    // separate concern (petname). Re-marking the same object is idempotent.
    const bob = {};
    const before = partyMark(bob);
    // (a name would be assigned by the host's address book, not here)
    const after = partyMark(bob);
    expect(after).to.equal(before);
  });

  it('refuses a string designator — designate by object, not id', () => {
    expect(() => partyMark('did:key:z6Mk')).to.throw(
      TypeError,
      /object, not by id/,
    );
  });

  it('the returned mark is frozen', () => {
    const mark = partyMark({});
    expect(Object.isFrozen(mark)).to.equal(true);
  });
});
