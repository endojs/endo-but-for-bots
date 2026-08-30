/* global compareBytes, concatBytes, frozenBytes, passStyleOf, thawedBytes */

const check = (condition, message) => {
  if (!condition) {
    throw Error(message);
  }
};

const source = new Uint8Array([0, 1, 127, 128, 255]);
const bytes = frozenBytes(source);

check(passStyleOf(bytes) === 'byteArray', 'bytes must be pass-by-copy');
check(Object.isFrozen(bytes), 'bytes must be frozen');
check(
  /** @type {ArrayBuffer & { immutable: boolean }} */ (bytes.buffer)
    .immutable === true,
  'buffer must be immutable',
);
check(
  ArrayBuffer.isView(bytes) || Reflect.ownKeys(bytes).length === 0,
  'bytes must have the genuine or ordinary emulated shape',
);

const thawed = thawedBytes(bytes);
check(thawed.length === source.length, 'thawed bytes must preserve length');
for (let index = 0; index < source.length; index += 1) {
  check(thawed[index] === source[index], 'thawed bytes must preserve values');
}

const next = frozenBytes(new Uint8Array([0, 1, 127, 129, 0]));
check(
  /** @type {number} */ (compareBytes(bytes, next)) < 0,
  'byte comparison must preserve ordering',
);
check(
  concatBytes([bytes, next]).length === bytes.length + next.length,
  'byte concatenation must preserve length',
);
