// @ts-check
/**
 * Spike: can image bytes cross as a ByteArray instead of base64 text
 * (`designs/m8-interfaces.md` 6.6)? The M0 survey (J-0023) said a
 * `Uint8Array` is not passable; the data-reference spike
 * (`spike-dataref/design-ocapn.md` 7.3) passed a ByteArray answer into an
 * Ironhorse vat. Nothing in the build depends on the answer: it settles
 * whether `ImageSource` may later offer `readBytes(range) -> ByteArray`
 * and records the hub-log cost of adapter-to-adapter pages for CC-100.
 *
 * - P-B1: a Node peer answers a vat's call with a 1,024-byte ByteArray; the
 *   vat reads `byteLength` and byte 0 and answers them.
 * - P-B2: a vat builds a ByteArray and answers it to the Node peer.
 * - P-B3: 16, 32, 48 and 60 KiB ByteArrays toward the vat (ms per call),
 *   then 64 KiB (expected refused, the vat frame ceiling CC-027); base64
 *   text of the same bytes where it fits, for comparison.
 * - P-B4: 1 MiB as eight 128 KiB pages between two Node peers through the
 *   hub (a vat only relays the reference), as ByteArrays and as base64
 *   text: ms per page, `hub-log.jsonl` growth per page, and the relay
 *   vat's journal growth (zero when no page passes through it).
 *
 * One supervisor in throwaway state, under three minutes. Rows are JSON
 * lines (`_spike.js` `emit`).
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs --shared --label bytes -- \
 *     corepack yarn test test/spikes/byte-array-passing.test.js
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';
import { passStyleOf } from '@endo/far';

import { limits } from '../../config/defaults.js';
import {
  E,
  Far,
  attempt,
  emit,
  round1,
  spikesEnabled,
  startHost,
  takeRunLock,
} from './_spike.js';

const KiB = 1024;
const crankBudget = BigInt(process.env.BYTES_BUDGET ?? limits.crankBudget);

/**
 * The probe vat: it calls a Node peer, takes ByteArray and text
 * arguments, builds ByteArrays, and holds one reference to relay.
 */
const BYTE_PROBE = `({ make: () => {
  let peer;
  let held;
  const describe = b => harden({
    tag: Object.prototype.toString.call(b),
    length: b.byteLength,
    first: typeof b.at === 'function' ? b.at(0) : b[0],
    frozen: Object.isFrozen(b),
  });
  const filled = n => {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = (i + 7) % 251;
    return raw;
  };
  return Far('ByteProbe', {
    ping: () => 1,
    setPeer: p => { peer = p; return true; },
    askBytes: n => E(peer).bytes(n).then(describe),
    take: b => b.byteLength,
    takeText: s => s.length,
    makeBytes: n => harden(new Uint8Array(filled(n).buffer.sliceToImmutable())),
    makeFromBase64: s => harden(new Uint8Array(Uint8Array.fromBase64(s).buffer.sliceToImmutable())),
    probeFromBase64: s => {
      const u = Uint8Array.fromBase64(s);
      return harden([u.length, u[0], u[u.length - 1], u.buffer.byteLength, u.byteOffset, new Uint8Array(u.buffer.sliceToImmutable())[0]]);
    },
    hold: x => { held = x; return true; },
    give: () => held,
  });
} })`;

/**
 * `n` bytes, byte i = (i + 7) % 251; `byteArrayOf` is the same as a
 * ByteArray (the pass style `byteArray`).
 * @param {number} n
 */
const rawOf = n => {
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) raw[i] = (i + 7) % 251;
  return raw;
};
/** @param {number} n */
const byteArrayOf = n =>
  harden(new Uint8Array(rawOf(n).buffer.sliceToImmutable()));
/**
 * Base64 of the same bytes, from the mutable array: `Buffer.from` of a
 * ByteArray over the emulated immutable buffer reads zeros in Node (a
 * first run of this spike sent 1,024 zero bytes that way).
 * @param {number} n
 */
const base64Of = n => Buffer.from(rawOf(n)).toString('base64');

/**
 * Every `hub-log.jsonl` under `root` (the serve layout may nest it).
 * @param {string} root
 * @returns {Promise<string[]>}
 */
const hubLogsUnder = async root => {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full);
      } else if (entry.name === 'hub-log.jsonl') found.push(full);
    }
  };
  await walk(root);
  return found;
};

/** @param {string[]} files */
const sizeOf = async files => {
  let total = 0;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    total += await stat(file).then(
      s => s.size,
      () => 0,
    );
  }
  return total;
};

/** @param {number[]} values */
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? undefined
    : sorted[Math.floor(sorted.length / 2)];
};

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike byte-array');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

run('ByteArray passing into, out of and between peers of a vat', async t => {
  t.timeout(3 * 60_000);
  const t0 = performance.now();
  const host = await startHost({ crankBudget, tag: 'ba' });
  const base = { spike: 'byte-array', crankBudget: String(crankBudget) };
  /** @type {Record<string, any>} */
  const seen = {};
  /**
   * @param {string} metric
   * @param {Record<string, unknown>} fields
   */
  const row = async (metric, fields) => {
    seen[metric] = fields;
    await emit({ ...base, metric, ...fields });
  };
  /** @type {any} */
  let second;
  try {
    const probe = await host.fresh(BYTE_PROBE);
    const { vat } = probe;

    // P-B1: a ByteArray answer from a Node peer into the vat.
    const peer = Far('BytePeer', {
      /** @param {number} n */
      bytes: n => byteArrayOf(n),
    });
    await E(vat).setPeer(peer);
    const b1 = await attempt(() => E(vat).askBytes(1024), {
      timeoutMs: 30_000,
    });
    await row('pb1.intoVat', {
      ok: b1.ok,
      ms: b1.ms,
      ...(b1.ok ? b1.value : { error: b1.error }),
      passable:
        b1.ok && b1.value.length === 1024 && b1.value.first === 7
          ? 'yes'
          : 'no',
    });

    // P-B2: a ByteArray built in the vat, answered out of it.
    for (const [variant, call] of /** @type {const} */ ([
      ['sliceToImmutable', () => E(vat).makeBytes(1024)],
      ['fromBase64', () => E(vat).makeFromBase64(base64Of(1024))],
    ])) {
      // eslint-disable-next-line no-await-in-loop
      const b2 = await attempt(call, { timeoutMs: 30_000 });
      const value = /** @type {any} */ (b2.value);
      const style = b2.ok ? passStyleOf(value) : undefined;
      // eslint-disable-next-line no-await-in-loop
      await row(`pb2.outOfVat.${variant}`, {
        ok: b2.ok,
        ms: b2.ms,
        ...(b2.ok
          ? {
              passStyle: style,
              length: value.byteLength,
              first: value.at(0),
              last: value.at(-1),
            }
          : { error: b2.error }),
        passable:
          b2.ok && style === 'byteArray' && value.byteLength === 1024
            ? 'yes'
            : 'no',
      });
    }

    // P-B2 diagnosis: what Uint8Array.fromBase64 answers in the vat
    // ([length, first, last, buffer length, offset, first after the slice]).
    const diag = await attempt(() => E(vat).probeFromBase64(base64Of(1024)), {
      timeoutMs: 30_000,
    });
    const tiny = await attempt(() => E(vat).probeFromBase64('AQID'), {
      timeoutMs: 30_000,
    });
    await row('pb2.fromBase64.inVat.AQID', {
      ok: tiny.ok,
      ...(tiny.ok ? { values: tiny.value } : { error: tiny.error }),
      expected: [3, 1, 3],
    });
    await row('pb2.fromBase64.inVat', {
      ok: diag.ok,
      ...(diag.ok ? { values: diag.value } : { error: diag.error }),
      expected: [1024, 7, (1023 + 7) % 251],
    });

    // P-B3: ByteArrays toward the vat; the vat frame ceiling.
    for (const kib of [16, 32, 48, 60, 64]) {
      const bytes = byteArrayOf(kib * KiB);
      /** @type {number[]} */
      const samples = [];
      /** @type {string | undefined} */
      let error;
      for (let i = 0; i < (kib === 64 ? 1 : 3) && error === undefined; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await attempt(() => E(vat).take(bytes), {
          timeoutMs: 30_000,
        });
        if (r.ok) samples.push(r.ms);
        else error = r.error;
      }
      const ms = median(samples);
      // eslint-disable-next-line no-await-in-loop
      await row(`pb3.toVat.bytes.${kib}KiB`, {
        bytes: kib * KiB,
        n: samples.length,
        ...(ms === undefined
          ? {}
          : { ms, usPerByte: round1((ms * 1000) / (kib * KiB)) }),
        ...(error === undefined ? {} : { error }),
      });
    }
    for (const kib of [16, 32, 45]) {
      const textValue = base64Of(kib * KiB);
      /** @type {number[]} */
      const samples = [];
      /** @type {string | undefined} */
      let error;
      for (let i = 0; i < 3 && error === undefined; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await attempt(() => E(vat).takeText(textValue), {
          timeoutMs: 30_000,
        });
        if (r.ok) samples.push(r.ms);
        else error = r.error;
      }
      const ms = median(samples);
      // eslint-disable-next-line no-await-in-loop
      await row(`pb3.toVat.base64.${kib}KiB`, {
        bytes: kib * KiB,
        characters: textValue.length,
        n: samples.length,
        ...(ms === undefined
          ? {}
          : { ms, usPerByte: round1((ms * 1000) / (kib * KiB)) }),
        ...(error === undefined ? {} : { error }),
      });
    }
    const alive = await attempt(() => E(vat).ping(), { timeoutMs: 20_000 });
    await row('pb3.vatAliveAfter', { ok: alive.ok });

    // P-B4: pages between two Node peers through the hub; the vat relays
    // only the reference.
    const pageBytes = 128 * KiB;
    const pages = 8;
    const pageArrays = Array.from({ length: pages }, () =>
      byteArrayOf(pageBytes),
    );
    const pageTexts = pageArrays.map(() => base64Of(pageBytes));
    const pager = Far('Pager', {
      /** @param {number} i */
      page: i => pageArrays[i],
      /** @param {number} i */
      pageText: i => pageTexts[i],
    });
    await E(vat).hold(pager);
    const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
      import('@endo/thixotrope/local-control.js'),
      import('@endo/thixotrope/node-powers.js'),
    ]);
    second = await connectLocalControl(
      makeNodePowers(),
      path.join(host.root, 'control.sock'),
      { workspace: 'w' },
    );
    const relay = await second.call('lookup', probe.name);
    const remotePager = await E(relay).give();
    const logs = await hubLogsUnder(host.root);
    const logBefore = await sizeOf(logs);
    const journalOf = async () =>
      (await host.workers()).find(w => w.workerId === probe.workerId)
        ?.journalLength;
    for (const [form, method, check] of /** @type {const} */ ([
      [
        'bytes',
        'page',
        (/** @type {any} */ v) =>
          passStyleOf(v) === 'byteArray' && v.byteLength === pageBytes,
      ],
      [
        'base64',
        'pageText',
        (/** @type {any} */ v) =>
          typeof v === 'string' && v.length === pageTexts[0].length,
      ],
    ])) {
      /** @type {number[]} */
      const ms = [];
      /** @type {number[]} */
      const growth = [];
      let compactions = 0;
      /** @type {string | undefined} */
      let error;
      // eslint-disable-next-line no-await-in-loop
      const journalBefore = await journalOf();
      for (let i = 0; i < pages && error === undefined; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const before = await sizeOf(logs);
        // eslint-disable-next-line no-await-in-loop
        const r = await attempt(() => E(remotePager)[method](i), {
          timeoutMs: 30_000,
        });
        // eslint-disable-next-line no-await-in-loop
        const after = await sizeOf(logs);
        if (!r.ok) error = r.error;
        else if (!check(r.value)) error = 'wrong answer';
        else {
          ms.push(r.ms);
          // The log compacts above max(1 MiB, 2 x image): a shrink is a
          // compaction, not a page's cost.
          if (after < before) compactions += 1;
          else growth.push(after - before);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const journalAfter = await journalOf();
      // eslint-disable-next-line no-await-in-loop
      await row(`pb4.betweenPeers.${form}`, {
        pageBytes,
        pages: ms.length,
        msPerPage: median(ms),
        msTotal: round1(ms.reduce((a, b) => a + b, 0)),
        hubLogBytesPerPage: median(growth),
        hubLogBytesPerMiB:
          median(growth) === undefined
            ? undefined
            : Math.round(
                /** @type {number} */ (median(growth) * 1024 * 1024) /
                  pageBytes,
              ),
        compactions,
        hubLogs: logs.length,
        relayJournalGrowth:
          journalBefore === undefined || journalAfter === undefined
            ? undefined
            : journalAfter - journalBefore,
        ...(error === undefined ? {} : { error }),
      });
    }
    // The hub may commit after an answer: read the log once more later.
    await new Promise(resolve => setTimeout(resolve, 2000));
    await row('pb4.hubLogTotal', {
      bytesAdded: (await sizeOf(logs)) - logBefore,
      pagesMoved: 2 * pages,
      bytesMoved: 2 * pages * pageBytes,
    });
  } finally {
    second?.close();
    await host.close();
  }
  await row('total', { ms: round1(performance.now() - t0) });
  for (const metric of [
    'pb1.intoVat',
    'pb2.outOfVat.sliceToImmutable',
    'pb3.toVat.bytes.16KiB',
    'pb4.betweenPeers.bytes',
    'pb4.betweenPeers.base64',
  ])
    t.truthy(seen[metric], metric);
});

if (!spikesEnabled) {
  test('the byte-array spike runs only with THIX_HARNESS_SPIKES=1', t =>
    t.pass());
}
