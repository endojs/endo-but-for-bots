/** A value or a promise that resolves to a value. */
export type MaybePromise<T> = T | Promise<T>;

/** The producer-facing, fire-and-forget subset of a generator. */
export interface BufferSpring<TValue, TReturn = undefined> {
  next(value: MaybePromise<TValue>): void;
  return(value: MaybePromise<TReturn>): void;
  throw(error: Error): void;
}

/** The consumer-facing subset of an async iterator. */
export interface BufferSink<TValue, TReturn = undefined>
  extends AsyncIterableIterator<TValue, TReturn> {
  next(): Promise<IteratorResult<TValue, TReturn>>;
}

/** A one-way, unbounded asynchronous buffer. */
export interface Buffer<TValue, TReturn = undefined> {
  spring: BufferSpring<TValue, TReturn>;
  sink: BufferSink<TValue, TReturn>;
}

/**
 * Make an unbounded buffer.
 *
 * The spring enqueues values and terminal iterations, and the sink dequeues
 * them. There is no acknowledgement channel from sink to spring.
 */
export declare function makeBuffer<TValue, TReturn = undefined>(): Buffer<
  TValue,
  TReturn
>;
