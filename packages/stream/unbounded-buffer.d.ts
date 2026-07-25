export {
  type Buffer,
  type BufferSink,
  type BufferSpring,
  type MaybePromise,
} from './buffer.js';

import type { Buffer } from './buffer.js';

/** Make an unbounded buffer backed by an asynchronous promise queue. */
export declare function makeUnboundedBuffer<
  TValue,
  TReturn = undefined,
>(): Buffer<TValue, TReturn>;
