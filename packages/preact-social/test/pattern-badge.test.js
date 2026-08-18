// pattern-badge.test.js — the unspoofable trust badge, written as the attacks.
import { h } from 'preact';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import {
  derivePattern,
  getOrCreatePatternSecret,
  makePatternBadge,
} from '../src/pattern-badge.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('derivePattern', () => {
  it('is pure and stable — the same secret always yields the same pattern', () => {
    const a = derivePattern('secret-123');
    const b = derivePattern('secret-123');
    expect(b).to.deep.equal(a);
    expect(a.glyph).to.be.a('string');
    expect(a.phrase.split(' ')).to.have.length(2);
    expect(a.words[0]).to.not.equal(a.words[1]); // never "amber amber"
  });

  it('different secrets generally differ', () => {
    expect(derivePattern('one').phrase).to.not.equal(
      derivePattern('two').phrase,
    );
  });
});

describe('getOrCreatePatternSecret', () => {
  it('returns an existing secret, or creates and persists one', () => {
    const store = new Map();
    const storage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };
    let n = 0;
    const randomHex = () => `r${(n += 1)}`;
    const first = getOrCreatePatternSecret(storage, randomHex);
    expect(first).to.equal('r1');
    const second = getOrCreatePatternSecret(storage, randomHex);
    expect(second).to.equal('r1'); // persisted, not regenerated
  });

  it('fails to a per-session secret on storage denial, never to "no pattern"', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const secret = getOrCreatePatternSecret(storage, () => 'session-secret');
    expect(secret).to.equal('session-secret');
  });
});

describe('makePatternBadge', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  const SECRET = 'user-secret-xyz';
  const pattern = derivePattern(SECRET);

  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('renders the user pattern where a guest places it', () => {
    const Badge = makePatternBadge(SECRET);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch('div', null, ch(props.Badge, {})),
    );
    renderConfined(h(Guest, { Badge }), scratch);
    expect(scratch.textContent).to.contain(pattern.phrase);
    expect(scratch.textContent).to.contain(pattern.glyph);
  });

  it('the guest cannot read the pattern or secret — it draws blind', () => {
    const Badge = makePatternBadge(SECRET);
    const seen = [];
    const Peeker = confineComponent(({ h: ch }, props) => {
      const vnode = ch(props.Badge, {});
      seen.push(JSON.stringify(vnode.props || {}));
      try {
        seen.push(String(vnode.type));
        seen.push(String(props.Badge({})));
      } catch (e) {
        seen.push(`threw:${e && e.message}`);
      }
      return ch('div', null, vnode);
    });
    renderConfined(h(Peeker, { Badge }), scratch);
    expect(scratch.textContent).to.contain(pattern.phrase); // user sees it
    const blob = seen.join(' ');
    expect(blob).to.not.contain(pattern.phrase); // guest never does
    expect(blob).to.not.contain(pattern.glyph);
    expect(blob).to.not.contain(SECRET);
  });

  it('guest text renders BESIDE the pattern, never merged into it', () => {
    const Badge = makePatternBadge(SECRET);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.Badge, { text: 'you received funds' }),
    );
    renderConfined(h(Guest, { Badge }), scratch);
    // both present; the guest text is a separate node, the pattern is intact
    expect(scratch.textContent).to.contain('you received funds');
    expect(scratch.textContent).to.contain(pattern.phrase);
  });

  it('the guest cannot hide or restyle the badge (withLimitedCss)', () => {
    const Badge = makePatternBadge(SECRET);
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.Badge, { style: 'display:none', class: 'gone' }),
    );
    renderConfined(h(Guest, { Badge }), scratch);
    const badge = scratch.querySelector('.secure-badge');
    expect(badge).to.not.equal(null);
    expect(badge.className).to.equal('secure-badge');
    expect(badge.getAttribute('style') || '').to.not.contain('display:none');
  });

  it('a non-primitive text is dropped but the badge still renders (never vanishes)', () => {
    const Badge = makePatternBadge(SECRET, { label: 'default' });
    const Guest = confineComponent(({ h: ch }, props) =>
      ch(props.Badge, { text: { toString: () => 'sneaky' } }),
    );
    renderConfined(h(Guest, { Badge }), scratch);
    // the object text was dropped by withPrimitiveParams; the pattern is shown,
    // and the object's toString never ran into the badge
    expect(scratch.textContent).to.contain(pattern.phrase);
    expect(scratch.textContent).to.not.contain('sneaky');
  });
});
