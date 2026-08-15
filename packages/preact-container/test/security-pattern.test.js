// security-pattern.test.js — INCREMENT 2 of trusted-in-untrusted Secure UI: a forgery becomes
// RECOGNIZABLE.
//
// Increment 1 (sealComponent) made trusted content unreachable and unforgeable. It could not stop
// untrusted code DRAWING ITS OWN convincing badge — the "Impersonation" attack in dan's vault note.
// The security pattern closes that: the badge carries a rendering derived from a secret the untrusted
// context cannot observe, so an attacker imitating it is drawing blind.
//
// The tests that matter here are therefore about what the attacker CANNOT LEARN, not about what the
// badge looks like.
import { h } from 'preact';
import { renderConfined, unmount } from '../src/renderer.js';
import { confineComponent } from '../src/compartment.js';
import {
  derivePattern,
  sealPatternBadge,
  getOrCreatePatternSecret,
} from '../src/security-pattern.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('security pattern — making a forgery recognizable', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  const SECRET = 'user-secret-af93b21c77e4';

  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('derivation is STABLE — the same secret always gives the same badge (recognition depends on it)', () => {
    const a = derivePattern(SECRET);
    const b = derivePattern(SECRET);
    expect(a).to.deep.equal(b);
    expect(a.glyph).to.be.a('string');
    expect(a.phrase.split(' ')).to.have.length(2);
  });

  it('different secrets give different patterns, and a phrase never repeats a word', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const p = derivePattern(`secret-${i}`);
      expect(p.words[0]).to.not.equal(p.words[1]); // "amber amber" reads as a bug, not a badge
      seen.add(`${p.glyph}|${p.phrase}`);
    }
    // Blind guessing has to be impractical; a derivation that collapsed to a handful of badges would
    // make imitation easy even without observation.
    expect(seen.size).to.be.greaterThan(120);
  });

  it('the user sees the pattern — it really reaches the DOM (placed by a child, the supported path)', () => {
    const Badge = sealPatternBadge(SECRET, { label: 'Grant selfImprove?' });
    const p = derivePattern(SECRET);
    const Host = confineComponent(({ h: ch }, props) => ch('div', null, ch(props.Badge, null)));
    renderConfined(h(Host, { Badge }), scratch);
    expect(scratch.textContent).to.contain(p.glyph);
    expect(scratch.textContent).to.contain(p.phrase);
  });

  // NOT PINNED, deliberately: rendering a sealed component DIRECTLY at the host root (rather than
  // having a confined child place it) proved ORDER-DEPENDENT across runs — sometimes empty, sometimes
  // the badge. Placement by a child is the supported path and the only one these tests rely on; host
  // code never needs a seal (it can call its own function). Pinning behaviour I cannot yet explain
  // would either enshrine a bug or produce a flaky test, so this records the observation instead.
  // Worth chasing separately: it smells like install()/hook-arming order on the first render of a file.

  // ── THE WHOLE POINT: the untrusted context is drawing blind ────────────────────────────────────
  it('a confined child can PLACE the badge but cannot READ the pattern', () => {
    const Badge = sealPatternBadge(SECRET);
    const p = derivePattern(SECRET);
    const observations = [];
    const Attacker = confineComponent(({ h: ch }, props) => {
      const vnode = ch(props.Badge, { text: 'anything' });
      // everything the child can reach about what it just built
      observations.push(JSON.stringify(vnode.props || {}));
      observations.push(String(vnode.type && vnode.type.name));
      try { observations.push(String(vnode.type)); } catch { observations.push('str-threw'); }
      try { observations.push(JSON.stringify(Object.keys(vnode.type))); } catch { observations.push('keys-threw'); }
      // and the exfiltration call
      try { observations.push(JSON.stringify(props.Badge({ text: 'x' }))); } catch { observations.push('call-threw'); }
      return ch('div', null, vnode);
    });
    renderConfined(h(Attacker, { Badge }), scratch);

    expect(scratch.textContent).to.contain(p.phrase); // the USER sees it
    const leaked = observations.join(' ');
    expect(leaked).to.not.contain(p.phrase); // the CHILD never does
    expect(leaked).to.not.contain(p.glyph);
    expect(leaked).to.not.contain(SECRET);
  });

  it('the SECRET itself never appears anywhere the child or the DOM can be read for it', () => {
    const Badge = sealPatternBadge(SECRET);
    const Child = confineComponent(({ h: ch }, props) => ch('div', null, ch(props.Badge, null)));
    renderConfined(h(Child, { Badge }), scratch);
    expect(scratch.innerHTML).to.not.contain(SECRET);
    expect(JSON.stringify(Object.keys(Badge))).to.not.contain(SECRET);
    expect(String(Badge)).to.not.contain(SECRET);
  });

  it("the child's own text renders BESIDE the pattern, never inside it — no borrowed authority", () => {
    const Badge = sealPatternBadge(SECRET);
    const p = derivePattern(SECRET);
    const Child = confineComponent(({ h: ch }, props) =>
      // the attacker tries to make its own words look like part of the trusted pattern
      ch(props.Badge, { text: `${p.glyph} ${p.phrase} — you have received funds` }),
    );
    renderConfined(h(Child, { Badge }), scratch);
    // The pattern element and the child's text are distinct nodes: the child cannot merge into the
    // pattern's own span, so a reader comparing the badge to their remembered pattern still sees the
    // real one rendered by the host.
    const spans = [...scratch.querySelectorAll('.secure-badge > span')];
    expect(spans.length).to.be.greaterThan(2);
    expect(spans[0].textContent).to.equal(p.glyph);
    expect(spans[1].textContent).to.equal(p.phrase);
  });

  it('a child cannot smuggle style/handlers into the badge (params are primitives only)', () => {
    const Badge = sealPatternBadge(SECRET);
    const Child = confineComponent(({ h: ch }, props) =>
      ch(props.Badge, {
        text: 'ok',
        style: 'display:none',            // hide the real badge…
        class: 'not-secure',              // …or restyle it
        onClick: () => 'pwned',
        dangerouslySetInnerHTML: { __html: '<b>x</b>' },
      }),
    );
    renderConfined(h(Child, { Badge }), scratch);
    const el = scratch.querySelector('.secure-badge');
    expect(el).to.not.equal(null);                              // still present
    expect(el.getAttribute('style')).to.contain('inline-flex');  // host's style, not the child's
    expect(el.getAttribute('style')).to.not.contain('none');
    expect(el.className).to.contain('secure-badge');
  });

  it('two users get different badges from the same code (the secret is what differs)', () => {
    const mine = derivePattern('secret-A');
    const theirs = derivePattern('secret-B');
    expect(`${mine.glyph}${mine.phrase}`).to.not.equal(`${theirs.glyph}${theirs.phrase}`);
  });

  // ── secret lifecycle ───────────────────────────────────────────────────────────────────────────
  it('getOrCreatePatternSecret persists once and then returns the SAME secret', () => {
    const store = new Map();
    const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    let n = 0;
    const rand = () => `random-${(n += 1)}`;
    const first = getOrCreatePatternSecret(storage, rand);
    const second = getOrCreatePatternSecret(storage, rand);
    expect(second).to.equal(first);
    expect(n).to.equal(1); // created once — a secret that changed would change the badge and destroy recognition
  });

  it('when storage is denied it FAILS TO A WORKING PATTERN, never to no pattern', () => {
    const storage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    const secret = getOrCreatePatternSecret(storage, () => 'ephemeral-xyz');
    expect(secret).to.equal('ephemeral-xyz');
    const p = derivePattern(secret);
    expect(p.phrase.split(' ')).to.have.length(2); // a badge still renders; "no pattern" would train
    expect(p.glyph).to.be.a('string');             // the user to accept pattern-less prompts
  });
});
