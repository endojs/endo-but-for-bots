// @ts-check
import { decodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { makeSyncFilePowers } from '../src/platform/node/sync-files.js';

/**
 * Instrument only this disposable benchmark's powers, never global Node APIs.
 * Use with --import ./scripts/profile-mail-loader.mjs.
 * @param {any} powers
 * @param {string} destination
 * @param {string | undefined} workerBinary
 */
export const makeMailProfile = (powers, destination, workerBinary) => {
  const trace = globalThis[Symbol.for('thixotrope.mailProfile')];
  if (!trace) throw Error('Fine profiling requires profile-mail-loader.mjs');
  const frameType = frame => {
    if (frame?.t !== 'f') return frame?.t;
    const head = new TextDecoder().decode(
      decodeBase64(frame.b64).subarray(0, 64),
    );
    const tag = /^<(\d+)'/.exec(head);
    return tag
      ? head.slice(tag[0].length, tag[0].length + Number(tag[1]))
      : 'unknown';
  };
  const readers = [];
  const descriptors = new Map();
  const stack = [];
  const fileClass = path =>
    path?.endsWith('/hub.json') || path?.endsWith('/hub.json.experiment-log')
      ? 'hub'
      : path?.endsWith('/journal.jsonl')
        ? 'worker-journal'
        : path?.endsWith('/tables.json')
          ? 'worker-tables'
          : path?.includes('/sessions/')
            ? 'session-store'
            : 'other';
  const api = { ...fs };
  for (const name of [
    'openSync',
    'writeFileSync',
    'fsyncSync',
    'closeSync',
    'renameSync',
    'rmSync',
    'mkdirSync',
    'readFileSync',
    'statSync',
    'existsSync',
    'readdirSync',
  ]) {
    api[name] = (...args) => {
      const start = trace.clock();
      const fd =
        typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
      const operation =
        name === 'fsyncSync'
          ? fd?.directory
            ? 'directory-fsync'
            : 'file-fsync'
          : name.replace(/Sync$/, '');
      let result;
      try {
        result = fs[name](...args);
        return result;
      } finally {
        const end = trace.clock();
        trace.span('syscall', operation, start, end, {
          file: stack.at(-1)?.file ?? fileClass(fd?.path ?? args[0]),
          fdKind: fd?.directory ? 'directory' : 'file',
        });
        if (name === 'openSync' && typeof result === 'number') {
          descriptors.set(result, {
            path: args[0],
            directory: args[1] === 'r',
          });
        } else if (name === 'closeSync') descriptors.delete(args[0]);
      }
    };
  }
  const rawFiles = makeSyncFilePowers({
    fs: api,
    dirname,
    randomUUID,
    getUserId: () => process.getuid?.(),
  });
  const syncFiles = harden(
    Object.fromEntries(
      Object.entries(rawFiles).map(([name, fn]) => [
        name,
        (...args) => {
          const start = trace.clock();
          const file = fileClass(args[0]);
          stack.push({ file });
          try {
            return fn(...args);
          } finally {
            stack.pop();
            trace.span('filesystem', name, start, trace.clock(), { file });
          }
        },
      ]),
    ),
  );
  const processes = harden({
    ...powers.processes,
    spawn: (executable, args, options) => {
      const worker = args[0]?.endsWith('/heap.sqlite');
      const label = worker ? args[0].split('/').at(-2) : undefined;
      const stdio = worker ? [...options.stdio] : options.stdio;
      if (worker) stdio[2] = 'pipe';
      const child = powers.processes.spawn(
        worker && workerBinary ? workerBinary : executable,
        args,
        { ...options, stdio },
      );
      if (!worker) return child;
      readers.push(
        (async () => {
          for await (const line of child.lines(2)) {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              console.error(line);
              continue;
            }
            if (event.kind === 'mail.vm') trace.native(event, label);
            else console.error(line);
          }
        })(),
      );
      let request;
      return harden({
        ...child,
        input: fd => {
          const stream = child.input(fd);
          if (!stream || fd !== 0) return stream;
          return harden({
            write: text => {
              const message = JSON.parse(text);
              const envelope = message.source?.startsWith('thixotropeDispatch(')
                ? JSON.parse(
                    JSON.parse(
                      message.source.slice('thixotropeDispatch('.length, -2),
                    ),
                  )
                : undefined;
              request = {
                frameType: frameType(envelope),
                start: trace.clock(),
                name:
                  message.op === 'deliver'
                    ? 'deliver'
                    : message.source?.startsWith('thixotropeDispatch(')
                      ? 'dispatch'
                      : message.source ===
                          'JSON.stringify(thixotropeTakeOutbound())'
                        ? 'drain'
                        : message.op,
              };
              stream.write(text);
            },
            end: text => stream.end(text),
          });
        },
        lines: fd =>
          fd !== 1
            ? child.lines(fd)
            : {
                async *[Symbol.asyncIterator]() {
                  for await (const line of child.lines(fd)) {
                    if (request)
                      trace.span(
                        'worker-request',
                        request.name,
                        request.start,
                        trace.clock(),
                        {
                          pid: child.pid,
                          worker: label,
                          frameType: request.frameType,
                          outbound: JSON.parse(line).result?.startsWith('[')
                            ? JSON.parse(JSON.parse(line).result).map(frameType)
                            : undefined,
                        },
                      );
                    request = undefined;
                    yield line;
                  }
                },
              },
      });
    },
  });
  return harden({
    powers: harden({ ...powers, syncFiles, processes }),
    begin: trial => trace.begin(trial),
    end: window => trace.end(window),
    dump: async results => {
      await Promise.allSettled(readers);
      await writeFile(
        destination,
        JSON.stringify(
          {
            clock:
              'epoch milliseconds: Node performance.timeOrigin + performance.now; Rust SystemTime anchored durations',
            workerBinary: workerBinary ?? 'original',
            results,
            trials: trace.trials,
            events: trace.events,
          },
          null,
          2,
        ),
      );
    },
  });
};
harden(makeMailProfile);
