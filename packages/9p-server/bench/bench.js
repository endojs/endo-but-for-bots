// @ts-check
/* global Buffer, process */
/* eslint-disable no-await-in-loop */
//
// Micro-benchmark for the 9P bridge, driven by a raw 9P2000.L client over
// the bridge's Unix socket, in the three CapTP topologies PERFORMANCE.md
// describes:
//
//   mem      in-memory Filesystem, same process as the bridge
//   nodefs   node-fs Filesystem, same process as the bridge
//   captp1   node-fs Filesystem in a child process, one netstring CapTP hop
//   captp2   node-fs Filesystem two hops away, through a relay child
//            (what a cross-worker call through the daemon costs)
//
// Run: node packages/9p-server/bench/bench.js [mem,nodefs,captp1,captp2]
//
// This measures layers 3 to 8 of PERFORMANCE.md. It cannot measure the
// kernel v9fs client or the podman bind: the 9P client here issues exactly
// the messages named, with no cache and no readahead of its own.

import '@endo/init';

import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E } from '@endo/eventual-send';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended/in-memory.js';
import { makeNodeFilesystem } from '@endo/platform/fs/extended/node-fs.js';

// Workspace-relative: these are not dependencies of @endo/9p-server, and a
// benchmark that reproduces the daemon's worker transport should not make
// them ones. `bench/` is not published.
/* eslint-disable import/no-relative-packages */
import {
  bytesToMessage,
  makeMessageCapTP,
  messageToBytes,
} from '../../daemon/src/connection.js';
import {
  makeNetstringReader,
  makeNetstringWriter,
} from '../../netstring/index.js';
import { mapReader, mapWriter } from '../../stream/index.js';
import { makeNodeReader, makeNodeWriter } from '../../stream-node/index.js';
/* eslint-enable import/no-relative-packages */
import { makeFsBridge9p } from '../src/fs-bridge.js';
import {
  makeReader,
  makeWriter,
  tryParseMessage,
  wrapMessage,
} from '../src/wire.js';
import { T } from '../src/types.js';

const MSIZE = 131_072;
// What v9fs uses for one Tread/Twrite: the iounit the bridge advertises.
const IOUNIT = MSIZE - 24;
const FILE_COUNT = 1000;
const BIG_BYTES = 8 * 1024 * 1024;
const SMALL_READ = 4096;
const SMALL_READ_SPAN = 2 * 1024 * 1024;
const CONCURRENCY = 32;

const never = new Promise(() => {});

// ---------------------------------------------------------------- 9P client

/**
 * A 9P client that matches replies to requests by tag, so requests can be
 * left in flight concurrently.
 *
 * @param {string} socketPath
 */
const connectClient = async socketPath => {
  const sock = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  let buf = Buffer.alloc(0);
  /** @type {Map<number, (msg: any) => void>} */
  const waiters = new Map();
  sock.on('data', chunk => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      const parsed = tryParseMessage(buf);
      if (!parsed) break;
      buf = parsed.rest;
      const resolve = waiters.get(parsed.msg.tag);
      if (resolve) {
        waiters.delete(parsed.msg.tag);
        resolve(parsed.msg);
      }
    }
  });
  let nextTag = 1;
  /**
   * @param {number} type
   * @param {Buffer} payload
   * @returns {Promise<{ type: number, tag: number, payload: Buffer }>}
   */
  const request = (type, payload) => {
    const tag = nextTag;
    nextTag = (nextTag % 0xfffe) + 1;
    return new Promise(resolve => {
      waiters.set(tag, resolve);
      sock.write(wrapMessage(type, tag, payload));
    });
  };
  return { request, close: () => sock.destroy() };
};

/** @typedef {Awaited<ReturnType<typeof connectClient>>} Client */

/**
 * @param {{ type: number, payload: Buffer }} rep
 * @param {number} expected
 * @param {string} what
 */
const expect = (rep, expected, what) => {
  if (rep.type === T.Rlerror) {
    throw new Error(`${what}: Rlerror errno=${makeReader(rep.payload).u32()}`);
  }
  if (rep.type !== expected) {
    throw new Error(`${what}: expected type ${expected}, got ${rep.type}`);
  }
  return rep;
};

/** @param {Client} c */
const version = async c => {
  const w = makeWriter();
  w.u32(MSIZE);
  w.str('9P2000.L');
  const rep = expect(
    await c.request(T.Tversion, w.finish()),
    T.Rversion,
    'Tversion',
  );
  return makeReader(rep.payload).u32();
};

/**
 * @param {Client} c
 * @param {number} fid
 */
const attach = async (c, fid) => {
  const w = makeWriter();
  w.u32(fid);
  w.u32(0xffff_ffff);
  w.str('');
  w.str('');
  w.u32(0);
  expect(await c.request(T.Tattach, w.finish()), T.Rattach, 'Tattach');
};

/**
 * @param {Client} c
 * @param {number} fid
 * @param {number} newfid
 * @param {string[]} names
 */
const walk = async (c, fid, newfid, names) => {
  const w = makeWriter();
  w.u32(fid);
  w.u32(newfid);
  w.u16(names.length);
  for (const n of names) w.str(n);
  const rep = expect(
    await c.request(T.Twalk, w.finish()),
    T.Rwalk,
    `Twalk ${names.join('/')}`,
  );
  const got = makeReader(rep.payload).u16();
  if (got !== names.length) {
    throw new Error(
      `Twalk ${names.join('/')}: walked ${got} of ${names.length}`,
    );
  }
};

/**
 * @param {Client} c
 * @param {number} fid
 * @param {number} flags
 */
const lopen = async (c, fid, flags) => {
  const w = makeWriter();
  w.u32(fid);
  w.u32(flags);
  expect(await c.request(T.Tlopen, w.finish()), T.Rlopen, 'Tlopen');
};

/**
 * @param {Client} c
 * @param {number} fid
 * @param {bigint} offset
 * @param {number} count
 */
const read = async (c, fid, offset, count) => {
  const w = makeWriter();
  w.u32(fid);
  w.u64(offset);
  w.u32(count);
  const rep = expect(await c.request(T.Tread, w.finish()), T.Rread, 'Tread');
  return makeReader(rep.payload).u32();
};

/**
 * @param {Client} c
 * @param {number} fid
 * @param {bigint} offset
 * @param {number} count
 */
const readdir = async (c, fid, offset, count) => {
  const w = makeWriter();
  w.u32(fid);
  w.u64(offset);
  w.u32(count);
  const rep = expect(
    await c.request(T.Treaddir, w.finish()),
    T.Rreaddir,
    'Treaddir',
  );
  const r = makeReader(rep.payload);
  const bytes = r.u32();
  // Count entries and find the last cookie.
  let entries = 0;
  let last = offset;
  let consumed = 0;
  while (consumed < bytes) {
    r.u8();
    r.u32();
    r.u64(); // qid
    last = /** @type {bigint} */ (r.u64());
    r.u8();
    const name = r.str();
    consumed += 13 + 8 + 1 + 2 + Buffer.byteLength(name, 'utf8');
    entries += 1;
  }
  return { entries, last };
};

/**
 * @param {Client} c
 * @param {number} fid
 */
const getattr = async (c, fid) => {
  const w = makeWriter();
  w.u32(fid);
  w.u64(0x7ffn);
  expect(await c.request(T.Tgetattr, w.finish()), T.Rgetattr, 'Tgetattr');
};

/**
 * @param {Client} c
 * @param {number} dfid
 * @param {string} name
 */
const lcreate = async (c, dfid, name) => {
  const w = makeWriter();
  w.u32(dfid);
  w.str(name);
  w.u32(0o2);
  w.u32(0o644);
  w.u32(0);
  expect(await c.request(T.Tlcreate, w.finish()), T.Rlcreate, 'Tlcreate');
};

/**
 * @param {Client} c
 * @param {number} fid
 * @param {bigint} offset
 * @param {Uint8Array} data
 */
const write = async (c, fid, offset, data) => {
  const w = makeWriter(32 + data.length);
  w.u32(fid);
  w.u64(offset);
  w.u32(data.length);
  w.bytes(data);
  const rep = expect(await c.request(T.Twrite, w.finish()), T.Rwrite, 'Twrite');
  return makeReader(rep.payload).u32();
};

/**
 * @param {Client} c
 * @param {number} fid
 */
const clunk = async (c, fid) => {
  const w = makeWriter();
  w.u32(fid);
  expect(await c.request(T.Tclunk, w.finish()), T.Rclunk, 'Tclunk');
};

/**
 * @param {Client} c
 * @param {number} dfid
 * @param {string} name
 */
const unlinkat = async (c, dfid, name) => {
  const w = makeWriter();
  w.u32(dfid);
  w.str(name);
  w.u32(0);
  expect(await c.request(T.Tunlinkat, w.finish()), T.Runlinkat, 'Tunlinkat');
};

// ---------------------------------------------------------------- fixtures

/** @param {string} root */
const populateDisk = root => {
  const many = path.join(root, 'many');
  mkdirSync(many);
  for (let i = 0; i < FILE_COUNT; i += 1) {
    writeFileSync(path.join(many, `f${i}`), `file ${i}\n`);
  }
  mkdirSync(path.join(root, 'd1', 'd2', 'd3', 'd4'), { recursive: true });
  writeFileSync(path.join(root, 'd1', 'd2', 'd3', 'd4', 'leaf'), 'leaf\n');
  writeFileSync(path.join(root, 'big'), Buffer.alloc(BIG_BYTES, 0x61));
};

/** @param {any} fs */
const populateMemory = async fs => {
  const root = await E(fs).root();
  const many = await E(root).makeDirectory('many');
  for (let i = 0; i < FILE_COUNT; i += 1) {
    await E(many).write(`f${i}`, `file ${i}\n`);
  }
  const deep = await E(root).materialise(['d1', 'd2', 'd3', 'd4']);
  await E(deep).write('leaf', 'leaf\n');
  // The catalog `write(name, text)` guard caps its string argument, so the
  // big fixture goes through the stream writer in 1 MiB chunks.
  const big = await E(root).create('big', harden({}));
  const sink = iterateBytesWriter(await E(big).write(0n), { buffer: 1 });
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  for (let i = 0; i < BIG_BYTES / chunk.length; i += 1) {
    await sink.next(chunk);
  }
  await sink.return(undefined);
  await E(big).close();
};

// ---------------------------------------------------------------- topologies

/**
 * @typedef {{
 *   fs: any,
 *   counters: { sent: number, received: number, bytesOut: number, bytesIn: number },
 *   close: () => void,
 * }} Topology
 */

/** @returns {Promise<Topology>} */
const memTopology = async () => {
  const fs = makeInMemoryFilesystem();
  await populateMemory(fs);
  return {
    fs,
    counters: { sent: 0, received: 0, bytesOut: 0, bytesIn: 0 },
    close: () => {},
  };
};

/** @param {string} root @returns {Promise<Topology>} */
const nodefsTopology = async root => ({
  fs: makeNodeFilesystem({ rootPath: root }),
  counters: { sent: 0, received: 0, bytesOut: 0, bytesIn: 0 },
  close: () => {},
});

/**
 * @param {string} root
 * @param {'fs' | 'relay'} mode
 * @returns {Promise<Topology>}
 */
const captpTopology = async (root, mode) => {
  const child = fork(
    fileURLToPath(new URL('./child.js', import.meta.url)),
    [],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, BENCH_MODE: mode, BENCH_ROOT: root },
    },
  );
  const counters = { sent: 0, received: 0, bytesOut: 0, bytesIn: 0 };
  const bytesWriter = makeNodeWriter(/** @type {any} */ (child.stdio[3]));
  const bytesReader = makeNodeReader(/** @type {any} */ (child.stdio[4]));
  const messageWriter = mapWriter(
    makeNetstringWriter(bytesWriter, { chunked: true }),
    message => {
      const bytes = messageToBytes(message);
      counters.sent += 1;
      counters.bytesOut += bytes.length;
      return bytes;
    },
  );
  const messageReader = mapReader(makeNetstringReader(bytesReader), bytes => {
    counters.received += 1;
    counters.bytesIn += bytes.length;
    return bytesToMessage(bytes);
  });
  const { getBootstrap } = makeMessageCapTP(
    'bench',
    messageWriter,
    messageReader,
    never,
    harden({}),
  );
  const fs = getBootstrap();
  // Make sure the far end is up before timing anything.
  await E(fs).statfs();
  return { fs, counters, close: () => child.kill() };
};

// ---------------------------------------------------------------- timing

const now = () => Number(process.hrtime.bigint()) / 1000; // microseconds

/**
 * @param {number} iterations
 * @param {() => Promise<unknown>} op
 * @returns {Promise<{ mean: number, p50: number, p99: number, total: number }>}
 */
const timeEach = async (iterations, op) => {
  const samples = [];
  const start = now();
  for (let i = 0; i < iterations; i += 1) {
    const t0 = now();
    await op();
    samples.push(now() - t0);
  }
  const total = now() - start;
  samples.sort((a, b) => a - b);
  return {
    mean: total / iterations,
    p50: samples[Math.floor(samples.length * 0.5)],
    p99: samples[Math.floor(samples.length * 0.99)],
    total,
  };
};

/**
 * @param {Topology['counters']} counters
 * @returns {() => { messages: number, bytes: number }}
 */
const snapshotMessages = counters => {
  const sent = counters.sent;
  const received = counters.received;
  const bytes = counters.bytesOut + counters.bytesIn;
  return () => ({
    messages: counters.sent - sent + (counters.received - received),
    bytes: counters.bytesOut + counters.bytesIn - bytes,
  });
};

// ---------------------------------------------------------------- benchmarks

/**
 * @param {string} name
 * @param {Topology} topology
 * @returns {Promise<Record<string, string>>}
 */
const runTopology = async (name, topology) => {
  const sockDir = mkdtempSync(path.join(os.tmpdir(), 'endo-9p-bench-sock-'));
  const socketPath = path.join(sockDir, '9p.sock');
  const bridge = makeFsBridge9p({ fs: topology.fs, socketPath });
  await E(bridge).start();
  const c = await connectClient(socketPath);
  /** @type {Record<string, string>} */
  const out = {};
  /**
   * @param {string} label
   * @param {{ mean: number, p50: number, p99: number }} r
   * @param {{ messages: number, bytes: number }} delta
   * @param {number} ops
   */
  const perOp = (label, r, delta, ops) => {
    const msgs =
      delta.messages > 0
        ? `, ${(delta.messages / ops).toFixed(1)} msgs/op`
        : '';
    out[label] =
      `${r.mean.toFixed(0)} µs (p50 ${r.p50.toFixed(0)}, p99 ${r.p99.toFixed(0)}${msgs})`;
  };
  try {
    await version(c);
    await attach(c, 0);

    if (name.startsWith('captp')) {
      const delta = snapshotMessages(topology.counters);
      const r = await timeEach(200, () => E(topology.fs).statfs());
      perOp('CapTP round trip (statfs)', r, delta(), 200);
    }

    // The kernel's stat pattern under cache=none: Twalk, Tgetattr, Tclunk.
    {
      const delta = snapshotMessages(topology.counters);
      await walk(c, 0, 1, ['many']);
      let i = 0;
      const r = await timeEach(FILE_COUNT, async () => {
        await walk(c, 1, 2, [`f${i}`]);
        await getattr(c, 2);
        await clunk(c, 2);
        i += 1;
      });
      perOp('stat one file (Twalk+Tgetattr+Tclunk)', r, delta(), FILE_COUNT);
    }

    {
      await walk(c, 1, 3, ['f0']);
      const delta = snapshotMessages(topology.counters);
      const r = await timeEach(2000, () => getattr(c, 3));
      perOp('Tgetattr', r, delta(), 2000);
    }

    {
      const delta = snapshotMessages(topology.counters);
      const r = await timeEach(500, async () => {
        await walk(c, 0, 4, ['d1', 'd2', 'd3', 'd4', 'leaf']);
        await clunk(c, 4);
      });
      perOp('Twalk 5 names + Tclunk', r, delta(), 500);
    }

    {
      const delta = snapshotMessages(topology.counters);
      const t0 = now();
      const K = CONCURRENCY;
      await Promise.all(Array.from({ length: K }, () => getattr(c, 3)));
      const total = now() - t0;
      const d = delta();
      out[`${K} concurrent Tgetattr`] =
        `${total.toFixed(0)} µs total, ${(total / K).toFixed(0)} µs/op${
          d.messages ? `, ${(d.messages / K).toFixed(1)} msgs/op` : ''
        }`;
    }

    {
      await walk(c, 0, 5, ['big']);
      await lopen(c, 5, 0);
      const delta = snapshotMessages(topology.counters);
      let offset = 0n;
      let reads = 0;
      const t0 = now();
      for (;;) {
        const n = await read(c, 5, offset, IOUNIT);
        reads += 1;
        if (n === 0) break;
        offset += BigInt(n);
        if (offset >= BigInt(BIG_BYTES)) break;
      }
      const total = now() - t0;
      const d = delta();
      out[`Tread ${IOUNIT} B sequential, ${BIG_BYTES / 1024 / 1024} MiB`] = `${(
        BIG_BYTES / total
      ).toFixed(0)} MB/s, ${(total / reads).toFixed(0)} µs/Tread${
        d.messages
          ? `, ${(d.messages / reads).toFixed(1)} msgs/op, ${(d.bytes / BIG_BYTES).toFixed(2)}× bytes`
          : ''
      }`;
      await clunk(c, 5);
    }

    {
      await walk(c, 0, 6, ['big']);
      await lopen(c, 6, 0);
      const delta = snapshotMessages(topology.counters);
      let offset = 0n;
      const reads = SMALL_READ_SPAN / SMALL_READ;
      const t0 = now();
      for (let i = 0; i < reads; i += 1) {
        await read(c, 6, offset, SMALL_READ);
        offset += BigInt(SMALL_READ);
      }
      const total = now() - t0;
      const d = delta();
      out[`Tread ${SMALL_READ} B sequential (page-fault pattern)`] =
        `${(total / reads).toFixed(0)} µs/Tread, ${(
          (reads / total) *
          1e6
        ).toFixed(
          0,
        )} Tread/s${d.messages ? `, ${(d.messages / reads).toFixed(1)} msgs/op` : ''}`;
      await clunk(c, 6);
    }

    {
      await walk(c, 0, 7, []);
      await lcreate(c, 7, 'out.bin');
      const chunk = new Uint8Array(IOUNIT).fill(0x62);
      const delta = snapshotMessages(topology.counters);
      let offset = 0n;
      let writes = 0;
      const t0 = now();
      while (offset < BigInt(BIG_BYTES)) {
        const n = await write(c, 7, offset, chunk);
        writes += 1;
        offset += BigInt(n);
      }
      const total = now() - t0;
      const d = delta();
      out[`Twrite ${IOUNIT} B sequential, ${BIG_BYTES / 1024 / 1024} MiB`] =
        `${(BIG_BYTES / total).toFixed(
          0,
        )} MB/s, ${(total / writes).toFixed(0)} µs/Twrite${
          d.messages
            ? `, ${(d.messages / writes).toFixed(1)} msgs/op, ${(d.bytes / BIG_BYTES).toFixed(2)}× bytes`
            : ''
        }`;
      await clunk(c, 7);
      await unlinkat(c, 0, 'out.bin');
    }

    {
      await walk(c, 0, 8, ['many']);
      await lopen(c, 8, 0);
      const delta = snapshotMessages(topology.counters);
      let offset = 0n;
      let entries = 0;
      let pages = 0;
      const t0 = now();
      for (;;) {
        const page = await readdir(c, 8, offset, MSIZE - 11);
        pages += 1;
        if (page.entries === 0) break;
        entries += page.entries;
        offset = page.last;
      }
      const total = now() - t0;
      const d = delta();
      out[`Treaddir ${FILE_COUNT} entries`] =
        `${total.toFixed(0)} µs total, ${pages} Treaddir, ${entries} entries${
          d.messages ? `, ${d.messages} CapTP msgs` : ''
        }`;
      await clunk(c, 8);
    }

    {
      const delta = snapshotMessages(topology.counters);
      let i = 0;
      const r = await timeEach(200, async () => {
        await walk(c, 0, 9, []);
        await lcreate(c, 9, `new${i}`);
        await clunk(c, 9);
        await unlinkat(c, 0, `new${i}`);
        i += 1;
      });
      perOp('create+clunk+unlink cycle', r, delta(), 200);
    }
  } finally {
    c.close();
    await E(bridge).stop();
    rmSync(sockDir, { recursive: true, force: true });
    topology.close();
  }
  return out;
};

// ---------------------------------------------------------------- main

const main = async () => {
  const wanted = (process.argv[2] || 'mem,nodefs,captp1,captp2').split(',');
  /** @type {Record<string, Record<string, string>>} */
  const results = {};
  for (const name of wanted) {
    const root = mkdtempSync(path.join(os.tmpdir(), `endo-9p-bench-${name}-`));
    try {
      let topology;
      if (name === 'mem') topology = await memTopology();
      else {
        populateDisk(root);
        if (name === 'nodefs') topology = await nodefsTopology(root);
        else if (name === 'captp1') topology = await captpTopology(root, 'fs');
        else if (name === 'captp2')
          topology = await captpTopology(root, 'relay');
        else throw new Error(`unknown topology ${name}`);
      }
      console.error(`[bench] ${name} …`);
      results[name] = await runTopology(name, topology);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const labels = [
    ...new Set(Object.values(results).flatMap(r => Object.keys(r))),
  ];
  console.log(`| op | ${wanted.join(' | ')} |`);
  console.log(`|---|${wanted.map(() => '---').join('|')}|`);
  for (const label of labels) {
    console.log(
      `| ${label} | ${wanted.map(n => results[n][label] ?? '—').join(' | ')} |`,
    );
  }
  console.log();
  console.log(
    `node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown cpu'}, ${os.platform()} ${os.release()}`,
  );
};

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  },
);
