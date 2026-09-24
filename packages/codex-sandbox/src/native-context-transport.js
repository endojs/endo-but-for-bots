// @ts-check
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeBrokerEnvironment } from './app-server-transport.js';

// Bound the serialized envelope, not just its unescaped native payload.
const LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const encoder = new TextEncoder();

/**
 * One-shot helper calls inside the existing sandbox. The owning client must
 * cancel on interruption and close on termination. No state or slice is owned.
 * @param {{slice: any, cwd: string}} options
 */
export const makeNativeContextTransport = ({ slice, cwd }) => {
  let closed = false;
  /** @type {any} */
  let active;
  const failure = stage => Error(`Codex native context ${stage} failed`);
  const cleanup = record => {
    if (record.reaped) return Promise.resolve();
    if (!record.cleanup) {
      record.cleanup = (async () => {
        await null;
        let proc;
        try {
          proc = await record.spawn;
        } catch {
          record.reaped = true;
          return;
        }
        // Kill failure remains owned and retryable; never label it reaped.
        try {
          await E(proc).kill();
        } catch {
          throw failure('cleanup');
        }
        // Sandbox wait rejects only after its cancelled process is reaped.
        await E(proc)
          .wait()
          .catch(() => undefined);
        // Reaping closes sandbox pipes. Retain the reservation until every
        // local reader/writer continuation has observed its terminal state.
        await Promise.allSettled(record.tasks || []);
        record.reaped = true;
      })().catch(error => {
        record.cleanup = undefined;
        throw error;
      });
    }
    return record.cleanup;
  };
  const invoke = (operation, request) => {
    if (closed) return Promise.reject(failure('closed'));
    if (active) return Promise.reject(failure('busy'));
    let input;
    try {
      input = encoder.encode(JSON.stringify({ operation, request }));
      if (input.byteLength > LIMIT) throw failure('input');
    } catch {
      return Promise.reject(failure('input'));
    }
    /** @type {any} */
    const record = { cancelled: false, reaped: false };
    active = record;
    record.cancelledP = new Promise((_, reject) => {
      record.rejectCancelled = () => reject(failure('cancelled'));
    });
    void record.cancelledP.catch(() => {});
    const assertLive = () => {
      if (record.cancelled || closed) throw failure('cancelled');
    };
    record.spawn = E(slice).spawn(
      harden(['node', '/opt/endo/context-command.mjs']),
      harden({
        cwd,
        env: makeBrokerEnvironment(),
        captureStdout: true,
        captureStderr: true,
        stdoutByteLimit: BigInt(LIMIT),
        stderrByteLimit: BigInt(STDERR_LIMIT),
      }),
    );
    /**
     * @param {any} reader
     * @param {number} limit
     * @param {boolean} retain
     */
    const read = async (reader, limit, retain) => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let text = '';
      for await (const chunk of iterateBytesReader(reader, { buffer: 0 })) {
        assertLive();
        size += chunk.byteLength;
        if (size > limit) throw failure('output');
        if (retain) text += decoder.decode(chunk, { stream: true });
      }
      if (retain) text += decoder.decode();
      return text;
    };
    record.done = (async () => {
      await null;
      let stage = 'spawn';
      try {
        const proc = await record.spawn;
        assertLive();
        stage = 'exchange';
        record.tasks = [
          (async () => {
            const stdin = await E(proc).stdin();
            assertLive();
            const writer = iterateBytesWriter(stdin, { buffer: 0 });
            const written = await writer.next(input);
            assertLive();
            if (written.done) throw failure('input');
            await writer.return();
          })(),
          E(proc)
            .stdout()
            .then(reader => read(reader, LIMIT, true)),
          E(proc)
            .stderr()
            .then(reader => read(reader, STDERR_LIMIT, false)),
          E(proc).wait(),
        ];
        const work = Promise.all(record.tasks);
        const [, output, , status] = await Promise.race([
          work,
          record.cancelledP,
        ]);
        assertLive();
        if (status?.code !== 0 || status?.signal) throw failure('exit');
        record.reaped = true;
        stage = 'response';
        const parsed = JSON.parse(output);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 ||
          !Object.hasOwn(parsed, 'result') ||
          !parsed.result ||
          typeof parsed.result !== 'object' ||
          Array.isArray(parsed.result)
        )
          throw failure(stage);
        return harden(parsed.result);
      } catch {
        await cleanup(record);
        throw failure(record.cancelled ? 'cancelled' : stage);
      } finally {
        if (record.reaped && active === record) active = undefined;
      }
    })();
    return record.done;
  };
  const cancel = async () => {
    const record = active;
    if (!record) return;
    record.cancelled = true;
    record.rejectCancelled();
    await cleanup(record);
    await record.done.catch(() => undefined);
    if (active === record) active = undefined;
  };
  const close = () => {
    closed = true;
    return cancel();
  };
  return harden({
    capture: request => invoke('capture', request),
    restore: request => invoke('restore', request),
    cancel,
    close,
  });
};
harden(makeNativeContextTransport);
