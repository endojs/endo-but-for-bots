// @ts-check

import { q } from '@endo/errors';

const TAR_BLOCK_SIZE = 512;
const textEncoder = new TextEncoder();

/**
 * @param {string} text
 * @param {Uint8Array} bytes
 * @param {number} start
 */
const writeText = (text, bytes, start) => {
  bytes.set(textEncoder.encode(text), start);
};

/**
 * @param {number} value
 * @param {number} width
 */
const tarNumber = (value, width) =>
  `${value.toString(8).padStart(width - 1, '0')}\0`;

/**
 * @param {string} path
 * @param {number} size
 */
const tarHeader = (path, size) => {
  if (textEncoder.encode(path).byteLength > 100) {
    throw new Error(`Tar path is too long: ${q(path)}`);
  }
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeText(path, header, 0);
  writeText(tarNumber(0o644, 8), header, 100);
  writeText(tarNumber(0, 8), header, 108);
  writeText(tarNumber(0, 8), header, 116);
  writeText(tarNumber(size, 12), header, 124);
  writeText(tarNumber(0, 12), header, 136);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeText('ustar\0', header, 257);
  writeText('00', header, 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeText(tarNumber(checksum, 8), header, 148);
  return header;
};

/**
 * Stream a ustar archive from a sequence of file entries.
 *
 * @param {AsyncIterable<{
 *   path: string,
 *   size: number,
 *   content: AsyncIterable<Uint8Array>,
 * }>} entries
 */
export async function* writeTar(entries) {
  for await (const { path, size, content } of entries) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${q(path)}`);
    }
    yield tarHeader(path, size);
    let remaining = size;
    for await (const chunk of content) {
      if (chunk.byteLength > remaining) {
        throw new Error(`Tar entry exceeds its declared size: ${q(path)}`);
      }
      remaining -= chunk.byteLength;
      yield chunk;
    }
    if (remaining !== 0) {
      throw new Error(`Tar entry is shorter than its declared size: ${q(path)}`);
    }
    const remainder = size % TAR_BLOCK_SIZE;
    if (remainder !== 0) yield new Uint8Array(TAR_BLOCK_SIZE - remainder);
  }
  yield new Uint8Array(TAR_BLOCK_SIZE * 2);
}
