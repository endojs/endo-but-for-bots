// @ts-check

import { makeCapTP } from '@endo/captp';
import { Fail, makeError, X } from '@endo/errors';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';

/**
 * Bounded CapTP over private inherited pipes. This is not a network listener.
 * Only the inference capability is exported by the credential-holding host.
 * Framing and capability routing use the repository's existing implementations.
 *
 * @param {object} options
 * @param {import('node:stream').Readable} options.input
 * @param {import('node:stream').Writable} options.output
 * @param {any} options.bootstrap
 * @param {number} [options.maxFrameBytes] Wire frames are explicitly <=8MiB.
 * @param {number} [options.maxQueuedBytes] Bounded queued outbound wire bytes.
 */
export const makeProviderPipe = ({
  input,
  output,
  bootstrap,
  maxFrameBytes = 8 * 1024 * 1024,
  maxQueuedBytes = 32 * 1024 * 1024,
}) => {
  (Number.isInteger(maxFrameBytes) &&
    maxFrameBytes > 0 &&
    maxFrameBytes <= 8 * 1024 * 1024 &&
    Number.isInteger(maxQueuedBytes) &&
    maxQueuedBytes >= maxFrameBytes &&
    maxQueuedBytes <= 32 * 1024 * 1024) ||
    Fail`Invalid provider pipe bounds`;
  let stopped = false;
  let queued = 0;
  let tail = Promise.resolve();
  /** @type {() => void} */
  let resolveClosed = () => {};
  const closed = new Promise(resolve => {
    resolveClosed = () => resolve(undefined);
  });
  const writer = makeNetstringWriter(makeNodeWriter(output));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf8', { fatal: true });
  const send = message => {
    if (stopped) return Promise.reject(makeError(X`Provider pipe closed`));
    const bytes = encoder.encode(JSON.stringify(message));
    if (
      bytes.byteLength > maxFrameBytes ||
      queued + bytes.byteLength > maxQueuedBytes
    ) {
      close();
      return Promise.reject(makeError(X`Provider pipe quota exceeded`));
    }
    queued += bytes.byteLength;
    const writing = tail.then(async () => {
      !stopped || Fail`Provider pipe closed`;
      const result = await writer.next(bytes);
      !result.done || Fail`Provider pipe closed`;
    });
    tail = writing.then(
      () => {},
      () => {},
    );
    void writing.catch(() => close());
    return writing.finally(() => {
      queued -= bytes.byteLength;
    });
  };
  const { dispatch, getBootstrap, abort } = makeCapTP(
    'private-provider-pipe',
    send,
    bootstrap,
    { onReject: () => close() },
  );
  const close = () => {
    if (stopped) return;
    stopped = true;
    abort(makeError(X`Provider pipe closed`));
    input.destroy();
    output.destroy();
    resolveClosed();
  };
  input.on('error', close);
  output.on('error', close);
  void (async () => {
    try {
      const reader = makeNetstringReader(makeNodeReader(input), {
        maxMessageLength: maxFrameBytes,
      });
      for await (const frame of reader) {
        dispatch(JSON.parse(decoder.decode(frame)));
      }
    } catch (_error) {
      // Framing/dispatch errors can contain peer data; never echo them.
    } finally {
      close();
    }
  })();
  return harden({ getBootstrap, closed, close });
};
harden(makeProviderPipe);
