// Mimics harness/regExpUtils.js buildString over N code points.
const N = 0x40000;
const CHUNK_SIZE = 10000;
let result = '';
let codePoints = [];
for (let length = 0, cp = 0; cp <= N; cp++) {
  if (cp >= 0xD800 && cp <= 0xDFFF) continue;
  codePoints[length++] = cp;
  if (length === CHUNK_SIZE) {
    result += String.fromCodePoint.apply(null, codePoints);
    codePoints.length = length = 0;
  }
}
result += String.fromCodePoint.apply(null, codePoints);
throw new Error('length=' + result.length);
