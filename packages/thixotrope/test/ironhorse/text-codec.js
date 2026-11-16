// @ts-check
// The Ironhorse boot's TextDecoder and TextEncoder, as a real worker runs
// them: built by the codec polyfill (`rust/endo/xsnap/src/polyfills.js`) on
// the VM's native UTF-8 codec, after the SES boot, metered at the default
// 10 M-computron crank budget.
//
// A probe boot file replaces the worker's dispatch with one that evaluates
// the delivered source in the start compartment, where the polyfill classes
// live (guest compartments do not receive them), so each `run` is one crank.
// The last test passes multi-byte strings through a real vat instead.
//
// Byte order marks: the polyfill used to keep a leading U+FEFF. The Encoding
// Standard strips one at the start of each stream unless `ignoreBOM` is set,
// as Node's TextDecoder (the other side of every OCapN connection) does, so
// the polyfill now does too.
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../../src/core/daemon.js';
import { makeIronhorseEngine } from '../../src/ironhorse/ironhorse-engine.js';
import { makeFsStore } from '../../src/store/store-fs.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const powers = makeNodePowers();
const packagePath = fileURLToPath(new URL('../../', import.meta.url));
const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  join(packagePath, '../../target/release/thixotrope-ironhorse-worker');
const bootDir =
  process.env.THIXOTROPE_BOOT_DIR ?? join(packagePath, 'dist-ironhorse');
const bootPaths = ['boot.js', 'worker-peer.js'].map(name =>
  join(bootDir, name),
);
await Promise.all([workerBinary, ...bootPaths].map(path => access(path)));

const probeBoot = `
(() => {
  const send = globalThis.thixotropeSend;
  const indirectEval = globalThis.eval;
  globalThis.thixotropeDispatch = json => {
    const { source } = JSON.parse(json);
    let reply;
    try {
      reply = { ok: true, value: indirectEval(source) };
    } catch (error) {
      reply = { ok: false, error: error.name + ': ' + error.message };
    }
    send(JSON.stringify(reply));
  };
  globalThis.hex = h => Uint8Array.fromHex(h);
  globalThis.units = s =>
    Array.from(s, c => c.codePointAt(0).toString(16)).join(',');
  globalThis.fatal = () => new TextDecoder('utf-8', { fatal: true });
})();
`;

/**
 * One worker booted with the shipped boot bundle and the probe dispatch.
 * `run(source)` is one delivery (one crank): the value, or `{ error }` for a
 * guest exception; a halt rejects.
 * @param {import('ava').ExecutionContext} t
 */
const makeProbe = async t => {
  const root = await mkdtemp(join(tmpdir(), 'thix-codec-'));
  const probePath = join(root, 'probe-boot.js');
  await writeFile(probePath, probeBoot);
  const engine = makeIronhorseEngine(powers, {
    workerBinary,
    bootPaths: [bootPaths[0], probePath],
    storePath: join(root, 'heaps'),
  });
  if (!engine.acquireStore) throw Error('Ironhorse requires store ownership');
  const release = await engine.acquireStore(root);
  /** @type {any} */
  let reply;
  const worker = await engine.start({
    debugName: 'text-codec',
    snapshot: null,
    onOutbound: frame => {
      reply = frame;
    },
  });
  t.teardown(async () => {
    try {
      await worker.terminate();
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  /** @param {string} source */
  const run = async source => {
    reply = undefined;
    await worker.deliver({ t: 'probe', source });
    return reply.ok ? reply.value : { error: reply.error };
  };
  return harden({ run });
};

const invalid = {
  error: 'TypeError: The encoded data was not valid for encoding utf-8',
};

test.serial(
  'a euro sign split across streaming calls decodes whole',
  async t => {
    const { run } = await makeProbe(t);
    t.is(
      await run(`
      var d = new TextDecoder();
      [d.decode(hex('e282'), { stream: true }), d.decode(hex('ac'), { stream: true }),
       d.decode()].map(units).join('/')`),
      '/20ac/',
    );
    t.is(
      await run(`
      var d = fatal();
      [d.decode(hex('41e2'), { stream: true }), d.decode(hex('82'), { stream: true }),
       d.decode(hex('ac42'))].map(units).join('/')`),
      '41//20ac,42',
    );
    // Flushed with the sequence still incomplete: one error, then a fresh start.
    t.is(
      await run(`
      var d = new TextDecoder();
      d.decode(hex('e282'), { stream: true });
      [d.decode(), d.decode(hex('41'))].map(units).join('/')`),
      'fffd/41',
    );
    t.deepEqual(
      await run(`
      var d = fatal(); d.decode(hex('f09f98'), { stream: true }); d.decode()`),
      invalid,
    );
  },
);

test.serial('fatal decoding throws a TypeError on c3 28', async t => {
  const { run } = await makeProbe(t);
  t.deepEqual(await run(`fatal().decode(hex('c328'))`), invalid);
  t.is(await run(`units(new TextDecoder().decode(hex('c328')))`), 'fffd,28');
  t.is(
    await run(`
      var d = fatal(); var e;
      try { d.decode(hex('c328')); } catch (error) { e = error; }
      [e instanceof TypeError, d.fatal, d.encoding].join()`),
    'true,true,utf-8',
  );
});

test.serial(
  'overlong, surrogate and out-of-range encodings are rejected',
  async t => {
    const { run } = await makeProbe(t);
    for (const [input, replaced] of [
      ['c0af', 'fffd,fffd'],
      ['c1bf', 'fffd,fffd'],
      ['e080af', 'fffd,fffd,fffd'],
      ['f08282ac', 'fffd,fffd,fffd,fffd'],
      ['eda080', 'fffd,fffd,fffd'],
      ['edbfbf', 'fffd,fffd,fffd'],
      ['f4908080', 'fffd,fffd,fffd,fffd'],
      ['f8888080', 'fffd,fffd,fffd,fffd'],
      // Maximal subparts: a truncated sequence is one error.
      ['e28241', 'fffd,41'],
      ['f09f9841', 'fffd,41'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await run(`fatal().decode(hex('${input}'))`), invalid, input);
      t.is(
        // eslint-disable-next-line no-await-in-loop
        await run(`units(new TextDecoder().decode(hex('${input}')))`),
        replaced,
        input,
      );
    }
  },
);

test.serial(
  'the encoder writes UTF-8 and U+FFFD for an unpaired surrogate',
  async t => {
    const { run } = await makeProbe(t);
    t.is(
      await run(`
        var e = new TextEncoder();
        [e.encode('a\\u00e9\\u20ac\\ud83d\\ude00').toHex(), e.encode('\\ud83d').toHex(),
         e.encode('x\\ude00y').toHex(), e.encode().length].join()`),
      '61c3a9e282acf09f9880,efbfbd,78efbfbd79,0',
    );
    t.is(
      await run(`
        var d = new Uint8Array(4);
        var r = new TextEncoder().encodeInto('a\\u20acb', d);
        [r.read, r.written, d.toHex()].join()`),
      '2,4,61e282ac',
    );
  },
);

test.serial(
  'a leading byte order mark is stripped unless ignoreBOM',
  async t => {
    const { run } = await makeProbe(t);
    t.is(await run(`units(new TextDecoder().decode(hex('efbbbf41')))`), '41');
    t.is(
      await run(
        `units(new TextDecoder('utf-8', { ignoreBOM: true }).decode(hex('efbbbf41')))`,
      ),
      'feff,41',
    );
    // Only the first: a second mark, or one after text, is content.
    t.is(
      await run(`units(new TextDecoder().decode(hex('efbbbfefbbbf')))`),
      'feff',
    );
    t.is(
      await run(`
        var d = new TextDecoder();
        [d.decode(hex('efbb'), { stream: true }), d.decode(hex('bf41'), { stream: true }),
         d.decode(hex('efbbbf'))].map(units).join('/')`),
      '/41/feff',
    );
  },
);

/**
 * xorshift32 over the Unicode scalar values: one in four astral, the rest
 * BMP outside the surrogates. Run in Node, and sent to the worker as source.
 * @param {number} seed
 * @param {number} count
 */
/* eslint-disable no-bitwise */
const generate = (seed, count) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const r = seed >>> 0;
    let cp =
      (r & 3) === 0 ? 0x1_0000 + ((r >>> 2) % 0x10_0000) : (r >>> 2) % 0xf800;
    if (cp >= 0xd800 && cp < 0xe000) cp += 0x800;
    out.push(cp);
  }
  return { seed, out };
};
/* eslint-enable no-bitwise */

test.serial(
  'a million random code points round-trip, each direction in one crank',
  async t => {
    t.timeout(180_000);
    const { run } = await makeProbe(t);
    const total = 1_000_000;
    const step = 50_000;
    await run(`globalThis.generate = ${String(generate)};
      globalThis.seed = 0x2545_f491; globalThis.pieces = []; 0`);
    // Generating is metered JavaScript, so it takes twenty cranks.
    for (let made = 0; made < total; made += step) {
      // eslint-disable-next-line no-await-in-loop
      await run(`
        var g = generate(seed, ${step}); seed = g.seed;
        for (var j = 0; j < g.out.length; j += 4096)
          pieces.push(String.fromCodePoint.apply(null, g.out.slice(j, j + 4096)));
        pieces.length`);
    }
    const length = await run(
      `globalThis.text = pieces.join(''); pieces = []; text.length`,
    );
    const expected = (() => {
      const { out } = generate(0x2545_f491, total);
      let text = '';
      for (let j = 0; j < out.length; j += 4096) {
        text += String.fromCodePoint(...out.slice(j, j + 4096));
      }
      return { text, bytes: Buffer.from(text, 'utf8') };
    })();
    t.is(length, expected.text.length);
    // Encode in one crank; compare the length and three windows with Node.
    const encoded = await run(`
      globalThis.bytes = new TextEncoder().encode(text);
      var n = bytes.length, w = 4096;
      [n, bytes.subarray(0, w).toHex(), bytes.subarray(Math.floor(n / 2) - w, Math.floor(n / 2) + w).toHex(),
       bytes.subarray(n - w).toHex()].join(' ')`);
    const n = expected.bytes.length;
    const w = 4096;
    t.is(
      encoded,
      [
        n,
        expected.bytes.subarray(0, w).toString('hex'),
        expected.bytes
          .subarray(Math.floor(n / 2) - w, Math.floor(n / 2) + w)
          .toString('hex'),
        expected.bytes.subarray(n - w).toString('hex'),
      ].join(' '),
    );
    // Decode in one crank, fatally, and compare with the source text.
    t.is(
      await run(
        `var back = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
         [back.length, back === text].join()`,
      ),
      `${expected.text.length},true`,
    );
  },
);

test.serial(
  'multi-byte strings pass into and out of a vat unchanged',
  async t => {
    t.timeout(180_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thix-codec-'));
    /** @type {Awaited<ReturnType<typeof makeThixotropeDaemon>> | undefined} */
    let daemon;
    t.teardown(async () => {
      try {
        await daemon?.crash();
      } finally {
        await rm(statePath, { recursive: true, force: true });
      }
    });
    daemon = await makeThixotropeDaemon(powers, {
      store: makeFsStore(powers, statePath),
      engine: makeIronhorseEngine(powers, {
        workerBinary,
        bootPaths,
        storePath: join(statePath, 'heaps'),
      }),
      codec: syrupCodec,
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    });
    const vat = await daemon.createWorker({ debugLabel: 'codec' });
    const echo = await vat.evaluate(`Far('echo', {
      twice: s => s + s,
      describe: s => [s.length, Array.from(s).length].join(),
      make: n => 'a\\u00e9\\u20ac\\ud83d\\ude00'.repeat(n),
    })`);
    // U+FEFF is not first: Syrup decodes each string with a default
    // (BOM-stripping) TextDecoder, in Node and now in the vat alike, so a
    // string that begins with U+FEFF loses it in transit (see JOURNAL J-0113).
    const sample = 'a\ufeff\u00e9\u20ac\ud83d\ude00\u0000\uffff\u{10ffff}';
    t.is(await E(echo).twice(sample), sample + sample);
    t.is(await E(echo).describe(sample), `${sample.length},8`);
    const inbound = 'a\u00e9\u20ac\ud83d\ude00'.repeat(800);
    t.is(await E(echo).describe(inbound), '4000,3200');
    // 50,000 repetitions: 250,000 UTF-16 units, 500,000 UTF-8 bytes out.
    t.is(
      await E(echo).make(50_000),
      'a\u00e9\u20ac\ud83d\ude00'.repeat(50_000),
    );
  },
);
