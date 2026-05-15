import test from 'ava';
import { parseBigint } from '../src/number-parse.js';

test('returns a bigint when input is a valid integer string', t => {
  t.is(parseBigint('42'), 42n);
  t.is(parseBigint('0'), 0n);
  t.is(parseBigint('   9007199254740993   '), 9_007_199_254_740_993n);
  t.is(
    parseBigint('123456789012345678901234567890'),
    123_456_789_012_345_678_901_234_567_890n,
  );
});

test('throws an error when input is not a valid integer string', t => {
  const badStrings = [
    'f00',
    'F00',
    '+1',
    '-1',
    '1.0',
    '01',
    'NaN',
    'Infinity',
    '-Infinity',
    '7up',
    ' ', // U+1680 OGHAM SPACE MARK (which is whitespace)
    '',
    '   ',
  ];
  for (const bad of badStrings) {
    t.throws(() => parseBigint(bad), { message: `Invalid number: ${bad}` });
  }
});
