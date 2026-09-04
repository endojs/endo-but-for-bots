// modifiers.test.js — the composable input disciplines.
import { withPrimitiveParams, withLimitedCss } from '../src/modifiers.js';

const endow = { h: () => null };

describe('withPrimitiveParams', () => {
  it('keeps primitives, drops objects/functions/arrays, preserves children', () => {
    let seen = null;
    const wrapped = withPrimitiveParams((_e, props) => {
      seen = props;
    });
    const children = ['sentinel'];
    wrapped(endow, {
      id: 'x',
      count: 3,
      flag: true,
      big: 10n,
      obj: { reach: 1 },
      fn: () => 'cap',
      arr: [1, 2],
      children,
    });
    expect(seen.id).to.equal('x');
    expect(seen.count).to.equal(3);
    expect(seen.flag).to.equal(true);
    expect(seen.big).to.equal(10n);
    expect(seen.obj).to.equal(undefined); // dropped
    expect(seen.fn).to.equal(undefined); // dropped
    expect(seen.arr).to.equal(undefined); // dropped
    expect(seen.children).to.equal(children); // preserved
  });

  it('drops rather than throws, so an always-render component is not blanked', () => {
    let ran = false;
    const wrapped = withPrimitiveParams((_e, _p) => {
      ran = true;
    });
    expect(() => wrapped(endow, { bad: {} })).to.not.throw();
    expect(ran).to.equal(true);
  });
});

describe('withLimitedCss', () => {
  it('drops style/class/className, keeps everything else and children', () => {
    let seen = null;
    const wrapped = withLimitedCss((_e, props) => {
      seen = props;
    });
    const children = ['sentinel'];
    wrapped(endow, {
      party: { real: true },
      text: 'hi',
      style: 'display:none',
      class: 'spoof',
      className: 'spoof2',
      children,
    });
    expect(seen.party).to.deep.equal({ real: true }); // non-CSS object kept
    expect(seen.text).to.equal('hi');
    expect(seen.style).to.equal(undefined);
    expect(seen.class).to.equal(undefined);
    expect(seen.className).to.equal(undefined);
    expect(seen.children).to.equal(children);
  });

  it('composes with withPrimitiveParams', () => {
    let seen = null;
    const wrapped = withLimitedCss(
      withPrimitiveParams((_e, props) => {
        seen = props;
      }),
    );
    wrapped(endow, { text: 'ok', style: 'x', payload: { cap: 1 } });
    expect(seen.text).to.equal('ok');
    expect(seen.style).to.equal(undefined); // dropped by withLimitedCss
    expect(seen.payload).to.equal(undefined); // dropped by withPrimitiveParams
  });
});
