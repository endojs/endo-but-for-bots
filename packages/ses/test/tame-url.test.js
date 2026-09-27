/* global globalThis */
import test from 'ava';
import '../index.js';

lockdown();

test('start compartment URL keeps the blob methods', t => {
  t.is(typeof URL, 'function');
  t.is(typeof URLSearchParams, 'function');
  t.true('createObjectURL' in URL);
  t.true('revokeObjectURL' in URL);
});

test('blob methods still work on the start compartment', t => {
  const url = URL.createObjectURL(new Blob(['hello']));
  t.true(url.startsWith('blob:'));
  URL.revokeObjectURL(url);
});

test('shared compartments get URL without the blob methods', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof URL'), 'function');
  t.is(c.evaluate('typeof URLSearchParams'), 'function');
  t.false(c.evaluate("'createObjectURL' in URL"));
  t.false(c.evaluate("'revokeObjectURL' in URL"));
  t.is(c.evaluate('typeof URL.parse'), typeof globalThis.URL.parse);
  t.is(c.evaluate('typeof URL.canParse'), typeof globalThis.URL.canParse);
});

test('shared compartments share URLSearchParams', t => {
  const c = new Compartment();
  t.is(c.evaluate('URLSearchParams'), URLSearchParams);
});

test('URL.prototype is shared across compartments', t => {
  const c = new Compartment();
  const SharedURL = c.evaluate('URL');
  t.not(SharedURL, URL);
  t.is(SharedURL.prototype, URL.prototype);
  t.is(URL.prototype.constructor, SharedURL);

  const startURL = new URL('http://example.com/');
  t.true(c.evaluate('url => url instanceof URL')(startURL));
  t.true(c.evaluate("new URL('http://example.com/')") instanceof URL);
});

test('the blob methods are unreachable from a shared compartment', t => {
  const c = new Compartment();
  t.is(
    c.evaluate(
      "typeof new URL('http://example.com/').constructor.createObjectURL",
    ),
    'undefined',
  );
});

test('URL and URLSearchParams are frozen', t => {
  const c = new Compartment();
  t.true(Object.isFrozen(URL));
  t.true(Object.isFrozen(c.evaluate('URL')));
  t.true(Object.isFrozen(URL.prototype));
  t.true(Object.isFrozen(URLSearchParams));
  t.true(Object.isFrozen(URLSearchParams.prototype));
});

test('the URLSearchParams iterator prototype is frozen', t => {
  const URLSearchParamsIteratorPrototype = Object.getPrototypeOf(
    new URLSearchParams().entries(),
  );
  t.true(Object.isFrozen(URLSearchParamsIteratorPrototype));
  t.is(
    Object.getPrototypeOf(new URLSearchParams().keys()),
    URLSearchParamsIteratorPrototype,
  );
  t.is(
    Object.getPrototypeOf(new URLSearchParams()[Symbol.iterator]()),
    URLSearchParamsIteratorPrototype,
  );
  t.is(
    Object.prototype.toString.call(new URLSearchParams().entries()),
    '[object URLSearchParams Iterator]',
  );
});

test('a compartment cannot tamper with the iterator prototype', t => {
  const tamperer = new Compartment();
  t.throws(
    () =>
      tamperer.evaluate(`
        Object.getPrototypeOf(new URLSearchParams().entries()).next = () => ({
          done: true,
        });
      `),
    { instanceOf: TypeError },
  );

  const other = new Compartment();
  t.deepEqual(other.evaluate("[...new URLSearchParams('a=1&b=2')]"), [
    ['a', '1'],
    ['b', '2'],
  ]);
});

test('URL semantics survive taming', t => {
  const c = new Compartment();
  t.is(new URL('http://example.com/a?b=1').searchParams.get('b'), '1');
  t.is(
    c.evaluate("new URL('http://example.com/a?b=1').searchParams.get('b')"),
    '1',
  );
  t.is(
    c.evaluate("new URL('b', 'http://example.com/a/').href"),
    'http://example.com/a/b',
  );
  t.is(c.evaluate("new URL('http://example.com/#x').hash"), '#x');
  t.is(
    c.evaluate("String(new URL('http://example.com'))"),
    'http://example.com/',
  );
  t.is(
    c.evaluate("new URL('http://example.com').toJSON()"),
    'http://example.com/',
  );
  t.throws(() => c.evaluate("new URL('not a url')"), { instanceOf: TypeError });
  t.throws(() => c.evaluate("URL('http://example.com/')"), {
    instanceOf: TypeError,
  });
  const url = c.evaluate(`
    const url = new URL('http://example.com/');
    url.pathname = '/p';
    url.searchParams.append('q', '1');
    url;
  `);
  t.is(url.href, 'http://example.com/p?q=1');
});

test('URL.parse and URL.canParse survive taming', t => {
  if (typeof URL.parse !== 'function' || typeof URL.canParse !== 'function') {
    t.pass('skipped: host lacks URL.parse or URL.canParse');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate("URL.parse('http://example.com/').href"),
    'http://example.com/',
  );
  t.is(c.evaluate("URL.parse('not a url')"), null);
  t.true(c.evaluate("URL.canParse('http://example.com/')"));
  t.false(c.evaluate("URL.canParse('not a url')"));
  t.true(c.evaluate("URL.parse('http://example.com/') instanceof URL"));
});

test('URL can be subclassed in a shared compartment', t => {
  const c = new Compartment();
  const url = c.evaluate(`
    class MyURL extends URL {}
    new MyURL('http://example.com/');
  `);
  t.is(url.href, 'http://example.com/');
  t.true(url instanceof URL);
});

test('URLSearchParams consumes an iterable argument into string copies', t => {
  const c = new Compartment();
  const params = c.evaluate(`
    const pair = ['a', { toString: () => '1' }];
    const params = new URLSearchParams([pair]);
    pair[0] = 'mutated';
    params;
  `);
  t.is(params.toString(), 'a=1');
});
