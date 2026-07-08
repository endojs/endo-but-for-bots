// @ts-check

// In-memory stand-ins for the Cloudflare bindings that the Cloudflare
// daemon platform accepts, mirroring the binding API subsets the
// adapters use (see CLOUDFLARE-STORAGE.md): a mock Durable Object
// SQLite storage handle backed by node's built-in SQLite (real SQL
// semantics from the same engine family the production target runs,
// with no native build step), and a Map-backed mock R2 bucket with
// streaming bodies, ranged gets, and delimited listing. The same test
// suite is designed to be re-pointed at Miniflare/workerd, which
// emulate the real services locally, in the build phase.

// @ts-ignore This repository's @types/node predates the built-in
// sqlite module's type declarations.
import { DatabaseSync } from 'node:sqlite';

/** @import { DurableObjectSqlStorage } from '../src/better-sqlite3-do.js' */
/** @import { R2Bucket, R2ObjectBody } from '../src/daemon-cloudflare-powers.js' */

// Statements that produce result rows, for routing between the
// run-shaped and all-shaped prepared-statement calls below.
const readerPattern = /^\s*(select|with|values|pragma|explain)\b/i;

/**
 * @returns {DurableObjectSqlStorage}
 */
export const makeMockDurableObjectSqlStorage = () => {
  const db = new DatabaseSync(':memory:');

  /**
   * @param {string} query
   * @param {Array<unknown>} bindings
   */
  const exec = (query, ...bindings) => {
    /** @type {Array<Record<string, unknown>>} */
    let rows = [];
    let rowsWritten = 0;
    if (bindings.length === 0 && !readerPattern.test(query)) {
      // The Durable Object exec accepts multi-statement strings only
      // when no bindings are passed, which covers schema DDL scripts.
      db.exec(query);
    } else if (readerPattern.test(query)) {
      rows = /** @type {Array<Record<string, unknown>>} */ (
        db.prepare(query).all(.../** @type {Array<string>} */ (bindings))
      );
    } else {
      const { changes } = db
        .prepare(query)
        .run(.../** @type {Array<string>} */ (bindings));
      rowsWritten = Number(changes);
    }
    return {
      toArray: () => rows,
      rowsWritten,
    };
  };

  return { sql: { exec } };
};

/**
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array>}
 */
const streamOfBytes = bytes =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const textDecoder = new TextDecoder();

/**
 * @param {Uint8Array} bytes
 * @returns {R2ObjectBody}
 */
const makeObjectBody = bytes => ({
  body: streamOfBytes(bytes),
  text: async () => textDecoder.decode(bytes),
  arrayBuffer: async () => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  },
});

/**
 * @returns {R2Bucket & { keys: () => Array<string> }}
 */
export const makeMockR2Bucket = () => {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map();

  return {
    put: async (key, value) => {
      objects.set(key, value.slice());
    },
    get: async (key, options) => {
      // No synchronous preamble.
      await null;

      const bytes = objects.get(key);
      if (bytes === undefined) {
        return null;
      }
      const range = options?.range;
      if (range !== undefined) {
        const { offset, length } = range;
        const end =
          length === undefined
            ? bytes.length
            : Math.min(offset + length, bytes.length);
        return makeObjectBody(bytes.subarray(offset, end));
      }
      return makeObjectBody(bytes);
    },
    head: async key => {
      const bytes = objects.get(key);
      if (bytes === undefined) {
        return null;
      }
      return { key, size: bytes.length };
    },
    delete: async key => {
      objects.delete(key);
    },
    list: async (options = {}) => {
      const { prefix = '', delimiter, limit } = options;
      /** @type {Array<{ key: string, size: number }>} */
      const listed = [];
      const delimitedPrefixes = new Set();
      for (const [key, bytes] of [...objects.entries()].sort()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const delimiterIndex =
            delimiter === undefined ? -1 : rest.indexOf(delimiter);
          if (delimiterIndex !== -1) {
            delimitedPrefixes.add(
              `${prefix}${rest.slice(0, delimiterIndex + 1)}`,
            );
          } else {
            listed.push({ key, size: bytes.length });
          }
          if (limit !== undefined && listed.length >= limit) {
            break;
          }
        }
      }
      return { objects: listed, delimitedPrefixes: [...delimitedPrefixes] };
    },
    keys: () => [...objects.keys()].sort(),
  };
};
