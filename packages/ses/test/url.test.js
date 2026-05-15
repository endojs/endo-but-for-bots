/* global globalThis */

import '../index.js';
import './_lockdown-safe.js';
import test from 'ava';

const hasURL = typeof globalThis.URL === 'function';
const hasURLSearchParams = typeof globalThis.URLSearchParams === 'function';

test('URL is present on the start compartment when the host provides it', t => {
  if (!hasURL) {
    t.pass('host does not provide URL; nothing to permit');
    return;
  }
  t.is(typeof globalThis.URL, 'function');
  t.is(typeof globalThis.URL.prototype.toString, 'function');
});

test('URLSearchParams is present on the start compartment when the host provides it', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams; nothing to permit');
    return;
  }
  t.is(typeof globalThis.URLSearchParams, 'function');
  t.is(typeof globalThis.URLSearchParams.prototype.append, 'function');
});

test('URL is identity-equal across compartments (universal)', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  const c = new Compartment();
  t.is(c.evaluate('typeof URL'), 'function');
  t.is(c.globalThis.URL, globalThis.URL);
  t.is(c.globalThis.URL.prototype, globalThis.URL.prototype);
});

test('URLSearchParams is identity-equal across compartments (universal)', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  const c = new Compartment();
  t.is(c.evaluate('typeof URLSearchParams'), 'function');
  t.is(c.globalThis.URLSearchParams, globalThis.URLSearchParams);
  t.is(
    c.globalThis.URLSearchParams.prototype,
    globalThis.URLSearchParams.prototype,
  );
});

test('URL constructor and prototype are frozen', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  t.true(Object.isFrozen(globalThis.URL));
  t.true(Object.isFrozen(globalThis.URL.prototype));
});

test('URLSearchParams constructor and prototype are frozen', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  t.true(Object.isFrozen(globalThis.URLSearchParams));
  t.true(Object.isFrozen(globalThis.URLSearchParams.prototype));
});

test('URLSearchParams iterator prototype is frozen', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  // The URL search params iterator prototype is the load-bearing hazard
  // this shim addresses: it is reachable only by walking an instance, not
  // by name on the global. If lockdown leaves it unfrozen, a compartment
  // that gets one URLSearchParams can mutate `.next` on its prototype and
  // influence iteration in every other compartment.
  const iteratorProto = Object.getPrototypeOf(new URLSearchParams().entries());
  t.true(Object.isFrozen(iteratorProto));
});

test('URLSearchParams iterator prototype.next cannot be replaced', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  // The cross-compartment confinement claim: tampering with the iterator
  // prototype's `next` from one compartment must not affect another.
  // Since the prototype is frozen, the assignment itself throws.
  const iteratorProto = Object.getPrototypeOf(new URLSearchParams().entries());
  t.throws(
    () => {
      iteratorProto.next = () => ({ value: 'tampered', done: false });
    },
    { instanceOf: TypeError },
  );
});

test('createObjectURL is cauterized from the URL constructor', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  // The dangerous static method is removed everywhere. In a browser this
  // mints handles into the document's blob registry, observable across
  // realms, which is ambient authority and exactly the kind of side-channel
  // ocap discipline forbids.
  t.false('createObjectURL' in URL);
  t.false('revokeObjectURL' in URL);
  const c = new Compartment();
  t.is(c.evaluate("'createObjectURL' in URL"), false);
  t.is(c.evaluate("'revokeObjectURL' in URL"), false);
});

test('round-trip URL parsing preserved in the start compartment', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  // Guards against accidental over-pruning of the URL prototype
  // accessors: if the permits cut `searchParams`, this would throw
  // "Cannot read properties of undefined".
  t.is(new URL('http://example.com/a?b=1').searchParams.get('b'), '1');
});

test('round-trip URL parsing preserved inside a compartment', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate('new URL("http://example.com/a?b=1").searchParams.get("b")'),
    '1',
  );
});

test('URL prototype accessors are reachable after lockdown', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  // Exercises every named accessor on the prototype so a permits-table
  // regression that prunes any of them surfaces here.
  const url = new URL(
    'https://alice:secret@example.com:8080/path/to?q=1&q=2#frag',
  );
  t.is(url.href, 'https://alice:secret@example.com:8080/path/to?q=1&q=2#frag');
  t.is(url.origin, 'https://example.com:8080');
  t.is(url.protocol, 'https:');
  t.is(url.username, 'alice');
  t.is(url.password, 'secret');
  t.is(url.host, 'example.com:8080');
  t.is(url.hostname, 'example.com');
  t.is(url.port, '8080');
  t.is(url.pathname, '/path/to');
  t.is(url.search, '?q=1&q=2');
  t.is(url.hash, '#frag');
});

test('URLSearchParams data methods preserved after lockdown', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  // Exercises append, delete, get, getAll, has, set, sort, size, and
  // toString on the prototype so a permits-table regression that prunes
  // any of them surfaces here.
  const params = new URLSearchParams('a=1&b=2&a=3');
  t.is(params.get('a'), '1');
  t.deepEqual(params.getAll('a'), ['1', '3']);
  t.true(params.has('b'));
  params.append('c', '4');
  t.is(params.toString(), 'a=1&b=2&a=3&c=4');
  params.delete('a');
  t.is(params.toString(), 'b=2&c=4');
  params.set('b', '99');
  t.is(params.get('b'), '99');
  t.is(params.size, 2);
});

test('URLSearchParams iteration methods preserved after lockdown', t => {
  if (!hasURLSearchParams) {
    t.pass('host does not provide URLSearchParams');
    return;
  }
  // The four iteration methods plus the default `@@iterator` each return
  // an instance of `%URLSearchParamsIteratorPrototype%`. Walking them
  // proves both the methods and the iterator prototype's `next` survived
  // the whitelist pass.
  const params = new URLSearchParams('a=1&b=2');
  t.deepEqual(
    [...params.entries()],
    [
      ['a', '1'],
      ['b', '2'],
    ],
  );
  t.deepEqual([...params.keys()], ['a', 'b']);
  t.deepEqual([...params.values()], ['1', '2']);
  t.deepEqual(
    [...params],
    [
      ['a', '1'],
      ['b', '2'],
    ],
  );
  const collected = [];
  params.forEach((value, key) => {
    collected.push([key, value]);
  });
  t.deepEqual(collected, [
    ['a', '1'],
    ['b', '2'],
  ]);
});

test('URL.parse static is preserved when the host provides it', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  if (typeof URL.parse !== 'function') {
    t.pass('host does not provide URL.parse');
    return;
  }
  // The static parse helper returns a URL or null, with no side channels.
  const parsed = URL.parse('http://example.com/a');
  t.not(parsed, null);
  t.is(parsed && parsed.pathname, '/a');
  t.is(URL.parse('not a url'), null);
});

test('URL.canParse static is preserved when the host provides it', t => {
  if (!hasURL) {
    t.pass('host does not provide URL');
    return;
  }
  if (typeof URL.canParse !== 'function') {
    t.pass('host does not provide URL.canParse');
    return;
  }
  t.is(URL.canParse('http://example.com/'), true);
  t.is(URL.canParse('not a url'), false);
});

test('@@toStringTag is preserved on the URL and URLSearchParams prototypes', t => {
  if (!hasURL || !hasURLSearchParams) {
    t.pass('host does not provide URL/URLSearchParams');
    return;
  }
  // The permits table names `@@toStringTag` on both prototypes and on the
  // URL search params iterator prototype. A regression that cuts the tag
  // would make `Object.prototype.toString.call(instance)` return
  // `'[object Object]'` instead of the standard-mandated tags.
  t.is(
    Object.prototype.toString.call(new URL('http://example.com/')),
    '[object URL]',
  );
  t.is(
    Object.prototype.toString.call(new URLSearchParams()),
    '[object URLSearchParams]',
  );
  t.is(
    new URLSearchParams().entries()[Symbol.toStringTag],
    'URLSearchParams Iterator',
  );
});
