// @ts-check
// The wasm engine's Node shell end to end through the staged launcher,
// without the Thixotrope host: the protocol against the native worker's, the
// pipes it must survive, the lease it must keep holding once the
// launcher has become Node, and the signal that must not open an inspector.
import test from '@endo/ses-ava/test.js';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

import { writeAll } from '../../src/ironhorse/wasm/shell.mjs';
import { AGREEMENT } from './_agreement.js';
import {
  NATIVE_WORKER,
  READY,
  WASM_WORKER,
  line,
  result,
  runWorker,
  startWorker,
  tempDir,
} from './_shell-harness.js';

/** @import { ExecutionContext } from 'ava' */

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test.serial(
  'replies agree byte for byte with the native worker, fresh and resumed',
  async t => {
    t.timeout(300_000);
    const dir = await tempDir(t);
    const wasmHeap = join(dir, 'wasm.sqlite');
    const nativeHeap = join(dir, 'native.sqlite');
    /** @type {string[]} */
    let transcript = [];
    for (const phase of ['fresh', 'resumed']) {
      // eslint-disable-next-line no-await-in-loop
      const wasm = await runWorker(t, WASM_WORKER, dir, wasmHeap, AGREEMENT);
      // eslint-disable-next-line no-await-in-loop
      const native = await runWorker(
        t,
        NATIVE_WORKER,
        dir,
        nativeHeap,
        AGREEMENT,
      );
      t.is(wasm.code, 0, `${phase}: ${wasm.stderr}`);
      t.is(wasm.stderr, '', phase);
      t.is(native.code, 0, `${phase}: ${native.stderr}`);
      t.is(wasm.lines[0], READY, phase);
      // Every request but the final close is answered.
      t.is(wasm.lines.length, AGREEMENT.length, phase);
      t.deepEqual(wasm.lines, native.lines, phase);
      transcript = wasm.lines;
    }
    // Each close committed: a third run reads the state the second left.
    const probe = line({ source: "order.join(',')" });
    const after = await runWorker(t, WASM_WORKER, dir, wasmHeap, [probe]);
    t.deepEqual(after.lines, [READY, transcript[AGREEMENT.indexOf(probe) + 1]]);
  },
);

/**
 * CPU seconds a Linux process has used, from `/proc/<pid>/stat`.
 *
 * @param {number} pid
 */
const cpuSeconds = pid => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // utime and stime, fields 14 and 15 of the whole line.
  return (Number(fields[11]) + Number(fields[12])) / 100;
};

test.serial(
  'megabyte lines arrive intact and in order past a stalled reader',
  async t => {
    t.timeout(180_000);
    const dir = await tempDir(t);
    const big = 'x'.repeat(5 * 1024 * 1024 + 3);
    const requests = [
      line({ source: `'${big}'.length` }),
      line({ source: "'y'.repeat(6000000)" }),
      line({ source: "'é€😀'" }),
      line({ source: "'z'.repeat(4000000) + 'end'" }),
      line({ source: "'after'" }),
    ];
    const worker = startWorker(t, WASM_WORKER, {
      heap: join(dir, 'heap.sqlite'),
      lease: join(dir, 'lease'),
      read: false,
    });
    worker.child.stdin?.end(requests.map(request => `${request}\n`).join(''));
    // Nobody reads stdout yet: the worker fills the pipe and must wait for
    // it without losing, reordering or busy-waiting over the reply.
    await delay(4000);
    t.is(worker.child.exitCode, null, 'the worker waits for its reader');
    if (platform === 'linux') {
      const before = cpuSeconds(worker.pid);
      await delay(2000);
      const spent = cpuSeconds(worker.pid) - before;
      t.true(spent < 0.5, `a blocked writer used ${spent} s of CPU in 2 s`);
    }
    worker.startReading();
    const { code } = await worker.exited;
    t.is(code, 0, worker.stderr());
    t.deepEqual(worker.lines, [
      READY,
      result(String(big.length)),
      result('y'.repeat(6_000_000)),
      result('é€😀'),
      result(`${'z'.repeat(4_000_000)}end`),
      result('after'),
    ]);
    t.is(worker.stdout(), worker.lines.join(''), 'nothing but whole lines');
  },
);

test.serial(
  'non-blocking pipes, split characters and an unterminated last line',
  async t => {
    t.timeout(180_000);
    const dir = await tempDir(t);
    const fifoIn = join(dir, 'in');
    const fifoOut = join(dir, 'out');
    execFileSync('mkfifo', [fifoIn, fifoOut]);
    const nonblocking = constants.O_NONBLOCK;
    // Every end is opened non-blocking, and the worker's ends share their
    // open file descriptions with this process, so the worker meets EAGAIN
    // on a full output pipe and on an empty input pipe.
    /* eslint-disable no-bitwise -- open(2) flags are a bit set */
    const readIn = openSync(fifoIn, constants.O_RDONLY | nonblocking);
    const writeIn = openSync(fifoIn, constants.O_WRONLY | nonblocking);
    const readOut = openSync(fifoOut, constants.O_RDONLY | nonblocking);
    const writeOut = openSync(fifoOut, constants.O_WRONLY | nonblocking);
    /* eslint-enable no-bitwise */
    const open = new Set([readIn, writeIn, readOut, writeOut]);
    /** @param {number} fd */
    const close = fd => {
      if (open.delete(fd)) closeSync(fd);
    };
    t.teardown(() => [...open].forEach(close));

    const worker = startWorker(t, WASM_WORKER, {
      heap: join(dir, 'heap.sqlite'),
      lease: join(dir, 'lease'),
      stdio: [readIn, writeOut, 'pipe'],
    });
    close(readIn);
    close(writeOut);

    const encoder = new TextEncoder();
    const input = encoder.encode(
      [
        line({ source: "'é€😀'" }),
        line({ source: "'y'.repeat(3000000)" }),
        line({ source: "'last'" }),
      ].join('\n'),
    );
    // Cut inside the four-byte character, inside the next line's JSON, and
    // just before the final line, with pauses between, so that every read
    // finds a partial line or nothing at all.
    const emoji = input.indexOf(0xf0);
    const cuts = [emoji + 1, emoji + 3, emoji + 20, input.lastIndexOf(0x0a)];
    let at = 0;
    for (const cut of [...cuts, input.length]) {
      writeAll(writeIn, input.subarray(at, cut));
      at = cut;
      // eslint-disable-next-line no-await-in-loop
      await delay(300);
    }
    close(writeIn);

    // Stall before reading: the reply is far larger than the pipe.
    await delay(3000);
    t.is(worker.child.exitCode, null, 'the worker waits for its reader');
    const chunks = [];
    const buffer = new Uint8Array(65_536);
    let ended = false;
    while (!ended) {
      let n = -1;
      try {
        n = readSync(readOut, buffer, 0, buffer.length, null);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EAGAIN') {
          throw error;
        }
      }
      if (n < 0) {
        // eslint-disable-next-line no-await-in-loop
        await delay(5);
      } else if (n === 0) {
        ended = true;
      } else {
        chunks.push(buffer.slice(0, n));
      }
    }
    const { code } = await worker.exited;
    t.is(code, 0, worker.stderr());
    t.is(worker.stderr(), '');
    const output = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    t.is(
      new TextDecoder().decode(output),
      [
        READY,
        result('é€😀'),
        result('y'.repeat(3_000_000)),
        result('last'),
      ].join(''),
    );
  },
);

/**
 * Whether `flock(1)` takes the lock on `path` without waiting.
 *
 * @param {string} path
 * @param {'--exclusive' | '--shared'} mode
 */
const flockSucceeds = (path, mode) => {
  try {
    execFileSync('flock', ['--nonblock', mode, path, 'true'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

test.serial('the Node worker holds the shared lease until it dies', async t => {
  t.timeout(120_000);
  const dir = await tempDir(t);
  const lease = join(dir, 'lease');
  const worker = startWorker(t, WASM_WORKER, {
    heap: join(dir, 'heap.sqlite'),
    lease,
  });
  await worker.waitForLines(1);
  // The worker has booted and is waiting for requests, as Node.
  t.regex(readFileSync(`/proc/${worker.pid}/cmdline`, 'utf8'), /node/);
  t.false(flockSucceeds(lease, '--exclusive'), 'exclusive is refused');
  t.true(flockSucceeds(lease, '--shared'), 'shared is granted');
  if (platform === 'linux') {
    const { ino } = statSync(lease);
    const holders = readFileSync('/proc/locks', 'utf8')
      .split('\n')
      .filter(entry => / FLOCK /.test(entry) && entry.includes(`:${ino} `));
    t.true(
      holders.some(entry => entry.split(/\s+/)[4] === String(worker.pid)),
      `the worker's pid ${worker.pid} holds the lease: ${holders.join('; ')}`,
    );
  }
  worker.child.kill('SIGKILL');
  const { signal } = await worker.exited;
  t.is(signal, 'SIGKILL');
  t.true(flockSucceeds(lease, '--exclusive'), 'exclusive once it is gone');
  t.true(existsSync(join(dir, 'heap.sqlite')));
});

/** @param {string} binary */
const engineName = binary => (binary === WASM_WORKER ? 'wasm' : 'native');

/**
 * Run a worker over these raw input bytes, then end its input.
 *
 * @param {ExecutionContext} t
 * @param {string} binary
 * @param {string} dir
 * @param {Uint8Array} input
 */
const runBytes = async (t, binary, dir, input) => {
  const worker = startWorker(t, binary, {
    heap: join(dir, `${engineName(binary)}.sqlite`),
    lease: join(dir, 'lease'),
  });
  worker.child.stdin?.end(input);
  const { code } = await worker.exited;
  return { stdout: worker.stdout(), code, stderr: worker.stderr() };
};

/**
 * The local TCP ports a process listens on, from its socket descriptors and
 * `/proc/net/tcp{,6}` (Linux).
 *
 * @param {number} pid
 */
const listeningPorts = pid => {
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) inodes.add(match[1]);
    } catch {
      // The descriptor closed while it was being listed.
    }
  }
  const ports = [];
  // A kernel without IPv6 has no tcp6 table.
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6'].filter(existsSync)) {
    for (const row of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      // st 0A is LISTEN; field 9 is the socket's inode.
      if (fields[3] === '0A' && inodes.has(fields[9])) {
        ports.push(Number.parseInt(fields[1].split(':')[1], 16));
      }
    }
  }
  return ports;
};

/**
 * Whether a signal is pending for the whole process (`ShdPnd`).
 *
 * @param {number} pid
 * @param {number} signal its number
 */
const signalPending = (pid, signal) => {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const mask = BigInt(`0x${/^ShdPnd:\s*([0-9a-f]+)$/m.exec(status)?.[1]}`);
  // eslint-disable-next-line no-bitwise -- a signal mask is a bit set
  return ((mask >> BigInt(signal - 1)) & 1n) === 1n;
};

test.serial(
  'SIGUSR1 opens no inspector: the native worker dies, the Node worker keeps serving',
  async t => {
    // Without `--disable-sigusr1` Node answers SIGUSR1 by starting its
    // inspector on 127.0.0.1:9229, a debugger into the heap. With it, Node
    // keeps the signal blocked in every thread, so it stays pending.
    t.timeout(120_000);
    const dir = await tempDir(t);
    const native = startWorker(t, NATIVE_WORKER, {
      heap: join(dir, 'native.sqlite'),
      lease: join(dir, 'lease'),
    });
    await native.waitForLines(1);
    native.child.kill('SIGUSR1');
    t.like(await native.exited, { code: null, signal: 'SIGUSR1' });

    const worker = startWorker(t, WASM_WORKER, {
      heap: join(dir, 'wasm.sqlite'),
      lease: join(dir, 'lease'),
    });
    await worker.waitForLines(1);
    worker.child.kill('SIGUSR1');
    await delay(2000);
    t.is(worker.child.exitCode, null, 'still running');
    if (platform === 'linux') {
      t.deepEqual(listeningPorts(worker.pid), [], 'it listens on no port');
      t.true(signalPending(worker.pid, 10), 'SIGUSR1 is held pending');
    }
    worker.child.stdin?.end(`${line({ source: '6 * 7' })}\n`);
    t.like(await worker.exited, { code: 0 });
    t.deepEqual(worker.lines, [READY, result('42')]);
    t.notRegex(worker.stderr(), /Debugger|inspector/i);
  },
);

test.serial(
  'a crank past its budget writes the native fatal line and keeps the last commit',
  async t => {
    t.timeout(180_000);
    const dir = await tempDir(t);
    const fatal = line({ source: 'for (;;) {}', budget: '100000' });
    /** @type {Record<string, Awaited<ReturnType<typeof runWorker>>>} */
    const runs = {};
    for (const binary of [WASM_WORKER, NATIVE_WORKER]) {
      const heap = join(dir, `${engineName(binary)}.sqlite`);
      // eslint-disable-next-line no-await-in-loop
      const first = await runWorker(t, binary, dir, heap, [
        line({ source: 'globalThis.kept = 1' }),
      ]);
      t.is(first.code, 0, first.stderr);
      // eslint-disable-next-line no-await-in-loop
      runs[engineName(binary)] = await runWorker(t, binary, dir, heap, [
        line({ source: 'kept = 2' }),
        fatal,
        line({ source: "'never answered'" }),
      ]);
    }
    const { wasm, native } = runs;
    t.is(wasm.code, 1);
    t.is(native.code, 1);
    t.deepEqual(wasm.lines, native.lines, 'byte for byte the native lines');
    t.is(wasm.lines.length, 3);
    const last = /** @type {string} */ (wasm.lines.at(-1));
    t.is(JSON.parse(last).op, 'fatal');
    t.is(wasm.stderr, `worker failed: ${JSON.parse(last).message}\n`);
    const after = await runWorker(
      t,
      WASM_WORKER,
      dir,
      join(dir, 'wasm.sqlite'),
      [line({ source: 'kept' })],
    );
    t.deepEqual(after.lines, [READY, result('1')], 'the last commit');
  },
);

test.serial(
  'a request that is not UTF-8 fails the worker, as natively',
  async t => {
    t.timeout(120_000);
    const dir = await tempDir(t);
    const encoder = new TextEncoder();
    const input = new Uint8Array([
      ...encoder.encode(`{"source":"'`),
      0xff,
      0xfe,
      ...encoder.encode(`'"}\n{"source":"1"}\n`),
    ]);
    const wasm = await runBytes(t, WASM_WORKER, dir, input);
    const native = await runBytes(t, NATIVE_WORKER, dir, input);
    t.is(wasm.code, 1);
    t.is(native.code, 1);
    t.is(wasm.stdout, READY, 'nothing after the ready line');
    t.is(wasm.stdout, native.stdout);
    t.is(wasm.stderr, 'worker failed: stream did not contain valid UTF-8\n');
  },
);

test.serial('CRLF-terminated requests are answered as natively', async t => {
  t.timeout(120_000);
  const dir = await tempDir(t);
  // JSON ignores a trailing `\r`, but an empty line does not: the native
  // worker answers it as an empty request (column 0), not as `\r` (column 1).
  const input = new TextEncoder().encode(
    `${line({ source: "'crlf'" })}\r\n\r\n${line({ source: '2' })}\r\n${line({ source: '3' })}\r`,
  );
  const wasm = await runBytes(t, WASM_WORKER, dir, input);
  const native = await runBytes(t, NATIVE_WORKER, dir, input);
  t.is(wasm.code, 0, wasm.stderr);
  t.is(native.code, 0, native.stderr);
  t.is(wasm.stdout, native.stdout);
  const lines = wasm.stdout.split(/(?<=\n)/);
  t.deepEqual(lines.slice(0, 2), [READY, result('crlf')]);
  t.regex(lines[2], /line 1 column 0"/);
  t.is(lines[3], result('2'));
});
