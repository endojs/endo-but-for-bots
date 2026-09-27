import test from 'ava';
import '../index.js';

lockdown({ urlBlobMethods: 'remove' });

test('the start compartment URL lacks the blob methods', t => {
  t.is(typeof URL, 'function');
  t.false('createObjectURL' in URL);
  t.false('revokeObjectURL' in URL);
});

test('one URL is shared by every compartment', t => {
  const c = new Compartment();
  t.is(c.evaluate('URL'), URL);
  t.is(URL.prototype.constructor, URL);
  t.is(new URL('http://example.com/a?b=1').searchParams.get('b'), '1');
});
