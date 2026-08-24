import test from 'ava';

test('package root exports crc32', async t => {
  const { crc32 } = await import('@endo/crc32');
  t.is(typeof crc32, 'function');
});
