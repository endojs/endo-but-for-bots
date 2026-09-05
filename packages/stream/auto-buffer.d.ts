/** A value or a promise that resolves to a value. */
export type MaybePromise<T> = T | Promise<T>;

/** The producer-facing, fire-and-forget subset of a generator. */
export interface AutoBufferSpring<TValue, TReturn = undefined> {
  next(value: MaybePromise<TValue>): void;
  return(value: MaybePromise<TReturn>): void;
  throw(error: Error): void;
}

/** The consumer-facing subset of an async iterator. */
export interface AutoBufferSink<TValue, TReturn = undefined>
  extends AsyncIterableIterator<TValue, TReturn> {
  next(): Promise<IteratorResult<TValue, TReturn>>;
}

/**
 * A one-way auto buffer: its storage grows automatically to retain every
 * produced value until the sink consumes it, applying no backpressure.
 */
export interface AutoBuffer<TValue, TReturn = undefined> {
  spring: AutoBufferSpring<TValue, TReturn>;
  sink: AutoBufferSink<TValue, TReturn>;
}

/**
 * Make an auto buffer backed by an asynchronous promise queue.
 *
 * The spring enqueues values and terminal iterations, and the sink dequeues
 * them. There is no acknowledgement channel from sink to spring.
 */
export declare function makeAutoBuffer<TValue, TReturn = undefined>(): AutoBuffer<
  TValue,
  TReturn
>;
