// @ts-check
/**
 * Spike S4 (milestones.md M0, W0.6): the cost of an adapter-to-adapter hop
 * through the hub (no vat on the path), and whether `hub.json` ever holds
 * frame payloads bound for transient sessions.
 *
 * Two installations of the fixture resource (two adapter processes). While
 * 2,000 events go from adapter A to adapter B, and 2,000 from a vat to
 * adapter B (20 cranks of 100 sendOnly), `hub.json` is sampled (stat every
 * few ms, read on every change, and a directory watch counts its rewrites)
 * and searched for a per-case marker, raw and hex-encoded (the hub queues
 * frames as hex, pkg/src/net/hub.js dispatchBytes/flushOutbox).
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s4.test.js
 */
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  ATTACH_FIXTURE,
  SPIKE_PROGRAM,
  hubJsonPath,
  startCrashHost,
  summarize,
} from './_crash.js';
import { E, emit, round1, spikesEnabled, takeRunLock } from './_spike.js';

const crankBudget = BigInt(process.env.S4_BUDGET ?? limits.crankBudget);
const EVENTS = Number(process.env.S4_EVENTS ?? 2000);
const PAYLOAD = Number(process.env.S4_PAYLOAD ?? 512);
const N_HOPS = Number(process.env.S4_HOPS ?? 2000);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s4');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

/** @param {string} text */
const hexOf = text => Buffer.from(text, 'utf8').toString('hex');

/**
 * Sample hub.json until stopped: sizes, rewrites, and whether any read of
 * it contained the marker (raw, lower-case hex or upper-case hex).
 * @param {string} root
 * @param {string} marker
 */
const monitorHub = (root, marker) => {
  const file = hubJsonPath(root);
  const needles = [marker, hexOf(marker), hexOf(marker).toUpperCase()];
  let stopped = false;
  let rewrites = 0;
  let polls = 0;
  let reads = 0;
  let readsWithMarker = 0;
  let maxBytes = 0;
  let minBytes = Infinity;
  let lastKey = '';
  const sizes = [];
  const watcher = watch(root, (_event, name) => {
    if (name === 'hub.json') rewrites += 1;
  });
  const loop = (async () => {
    while (!stopped) {
      polls += 1;
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(file).catch(() => undefined);
      if (info) {
        maxBytes = Math.max(maxBytes, info.size);
        minBytes = Math.min(minBytes, info.size);
        const key = `${info.ino}:${info.mtimeMs}:${info.size}`;
        if (key !== lastKey) {
          lastKey = key;
          sizes.push(info.size);
          // eslint-disable-next-line no-await-in-loop
          const text = await readFile(file, 'utf8').catch(() => '');
          reads += 1;
          if (needles.some(n => text.includes(n))) readsWithMarker += 1;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(2);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      watcher.close();
      const text = await readFile(file, 'utf8').catch(() => '');
      return {
        polls,
        distinctVersionsRead: reads,
        readsWithMarker,
        hubJsonRewritesSeen: rewrites,
        minBytes: minBytes === Infinity ? null : minBytes,
        maxBytes,
        medianBytes: sizes.length
          ? [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)]
          : null,
        finalBytes: Buffer.byteLength(text),
        finalHasMarker: needles.some(n => text.includes(n)),
      };
    },
  };
};

/**
 * A payload of `bytes` ASCII characters starting with a unique marker.
 * @param {string} label
 */
const payloadFor = label => {
  const marker = `S4MARK${label}${randomBytes(6).toString('hex')}`;
  return { marker, payload: marker + 'p'.repeat(PAYLOAD - marker.length) };
};

run('S4 adapter-to-adapter hops and hub.json payloads', async t => {
  t.timeout(40 * 60_000);
  const base = { spike: 'S4', crankBudget: String(crankBudget) };
  const host = await startCrashHost({ crankBudget, tag: 's4' });
  /** @type {Record<string, any>} */
  const found = {};
  try {
    await host.client.call('installNative', 'spkA', ATTACH_FIXTURE);
    await host.client.call('installNative', 'spkB', ATTACH_FIXTURE);
    await host.client.call('install', 'v', SPIKE_PROGRAM, [['spk', 'spkB']]);
    const vat = await host.client.call('lookup', 'v');
    const facetA = await host.client.call('lookup', 'spkA');
    const facetB = await host.client.call('lookup', 'spkB');
    const epA = await E(facetA).open();
    const epB = await E(facetB).open();
    const incA = await E(epA).incarnation();
    const incB = await E(epB).incarnation();
    await E(epA).connect(epB);
    const hubAtStart = (await stat(hubJsonPath(host.root))).size;
    await emit({
      ...base,
      metric: 's4.setup',
      incA,
      incB,
      separateProcesses: incA.split('-')[0] !== incB.split('-')[0],
      hubJsonBytes: hubAtStart,
    });

    // Host -> adapter direct, for reference.
    const hostEcho = [];
    for (let i = 0; i < 200; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(epA).echo('');
      hostEcho.push(performance.now() - t1);
    }
    await emit({
      ...base,
      metric: 's4.hostToAdapter.echo',
      unit: 'ms',
      ...summarize(hostEcho),
    });

    // Adapter A -> adapter B answered hops, timed in A, with hub.json watched.
    await E(epA).hop(20);
    for (const [size, n] of [
      [0, N_HOPS],
      [1024, 500],
      [16_384, 200],
    ]) {
      const { marker, payload } =
        size === 0
          ? {
              marker: `S4MARKnone${randomBytes(4).toString('hex')}`,
              payload: '',
            }
          : payloadFor(`hop${size}`);
      const monitor = monitorHub(host.root, marker);
      // eslint-disable-next-line no-await-in-loop
      const hops = await E(epA).hop(n, payload);
      // eslint-disable-next-line no-await-in-loop
      const hub = await monitor.stop();
      if (size > 0) found[`hop${size}Marker`] = hub.readsWithMarker > 0;
      // eslint-disable-next-line no-await-in-loop
      await emit({
        ...base,
        metric: `s4.adapterToAdapter.hop.${size}B`,
        unit: 'ms',
        ...hops,
        hub,
      });
      if (size === 0) found.hopMedian = hops.median;
    }

    // 2,000 sendOnly events adapter A -> adapter B.
    {
      const { marker, payload } = payloadFor('a2a');
      await E(epB).resetReceived();
      const monitor = monitorHub(host.root, marker);
      const t0 = performance.now();
      await E(epA).pushTo(EVENTS, payload);
      const got = await E(epB).waitReceived(EVENTS);
      const ms = round1(performance.now() - t0);
      await delay(500);
      const hub = await monitor.stop();
      found.a2aMarker = hub.readsWithMarker > 0 || hub.finalHasMarker;
      await emit({
        ...base,
        metric: 's4.push.adapterToAdapter',
        events: EVENTS,
        payloadBytes: PAYLOAD,
        received: got,
        totalMs: ms,
        eventsPerSecond: round1((EVENTS / ms) * 1000),
        hub,
      });
    }

    // 2,000 events from a vat to adapter B's endpoint (20 cranks x 100).
    {
      const { marker, payload } = payloadFor('v2a');
      await E(vat).setTarget(epB);
      await E(epB).resetReceived();
      const monitor = monitorHub(host.root, marker);
      const t0 = performance.now();
      const crankMs = [];
      for (let sent = 0; sent < EVENTS; sent += limits.sendsPerCrank) {
        const t1 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await E(vat).pushMany(limits.sendsPerCrank, payload);
        crankMs.push(performance.now() - t1);
      }
      const got = await E(epB).waitReceived(EVENTS);
      const ms = round1(performance.now() - t0);
      await delay(500);
      const hub = await monitor.stop();
      found.v2aMarker = hub.readsWithMarker > 0 || hub.finalHasMarker;
      await emit({
        ...base,
        metric: 's4.push.vatToAdapter',
        events: EVENTS,
        perCrank: limits.sendsPerCrank,
        payloadBytes: PAYLOAD,
        received: got,
        crankCallMs: summarize(crankMs),
        totalMs: ms,
        eventsPerSecond: round1((EVENTS / ms) * 1000),
        hub,
      });
    }

    // hub.json at rest, after everything settled.
    await delay(3000);
    const hubAtEnd = (await stat(hubJsonPath(host.root))).size;
    const text = await readFile(hubJsonPath(host.root), 'utf8');
    await emit({
      ...base,
      metric: 's4.hubJson.atRest',
      startBytes: hubAtStart,
      endBytes: hubAtEnd,
      anyMarkerAtRest: /S4MARK/.test(text) || text.includes(hexOf('S4MARK')),
      file: path.basename(hubJsonPath(host.root)),
    });
  } catch (error) {
    await emit({
      ...base,
      metric: 's4.error',
      error: String(/** @type {Error} */ (error)?.stack ?? error).slice(
        0,
        2000,
      ),
      stderr: host.stderrTail.slice(-2000),
    });
    throw error;
  } finally {
    await host.close();
  }
  // A measurement spike: it asserts only that it measured. Whether payloads
  // appear in hub.json is the finding, reported in the rows and the journal.
  t.true(typeof found.hopMedian === 'number', 'hop cost measured');
  t.log(
    `payload markers seen in hub.json: ${JSON.stringify({
      hop1024: found.hop1024Marker,
      hop16384: found.hop16384Marker,
      a2a: found.a2aMarker,
      v2a: found.v2aMarker,
    })}`,
  );
});

if (!spikesEnabled) {
  test('S4 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
