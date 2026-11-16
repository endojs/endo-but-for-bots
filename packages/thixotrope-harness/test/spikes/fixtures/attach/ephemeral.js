// @ts-check
/**
 * Throwaway native resource for spikes S2, S4, S7 and S9 (milestones.md M0,
 * W0.6): the transient adapter half of the attach pattern (architecture.md
 * D-7). One process per incarnation; nothing here survives a restart.
 *
 * - bind('service', { sink }) attaches this incarnation's ops facet to the
 *   manager and waits for the answer, so a reconcile that returns has a
 *   fresh facet in the manager's heap.
 * - bind('subN', { listener }) keeps a foreign remotable from the spec and
 *   tells it (sendOnly) which incarnation bound it (S7).
 * - The endpoint is the adapter-side object vats hold and call directly: it
 *   echoes, hangs, counts distinct presences (S2 d), appends fsynced effect
 *   lines (S9), hops to another adapter's endpoint and times hops and vat
 *   round trips with its own clock (S2, S4), and receives pushed events.
 */
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { makeAdapter } from '@endo/thixotrope/native-adapter.js';

/**
 * @param {number[]} samples
 */
const summary = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  /** @param {number} q */
  const at = q =>
    sorted.length === 0
      ? null
      : +sorted[
          Math.min(sorted.length - 1, Math.floor(q * sorted.length))
        ].toFixed(3);
  return harden({
    n: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length === 0 ? null : +sorted[sorted.length - 1].toFixed(3),
    min: sorted.length === 0 ? null : +sorted[0].toFixed(3),
  });
};

/**
 * @param {string} file
 * @param {string} line
 */
const appendSynced = (file, line) => {
  const fd = openSync(file, 'a', 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const make = () => {
  const incarnation = `${process.pid}-${randomBytes(4).toString('hex')}`;
  /** Presence -> ordinal, for one incarnation (S2 d). */
  const seen = new WeakMap();
  let distinct = 0;
  let sightings = 0;
  /** @type {Map<unknown, any>} */
  const listeners = new Map();
  /** Another adapter's endpoint (S4). */
  let peer;
  let receivedEvents = 0;
  let receivedBytes = 0;
  /** @type {{ target: number, resolve: (v: any) => void, t0: number } | undefined} */
  let waiter;
  let firstAt = 0;
  let lastAt = 0;

  /** @param {any} obj */
  const see = obj => {
    sightings += 1;
    if (!seen.has(obj)) {
      distinct += 1;
      seen.set(obj, distinct);
    }
    return seen.get(obj);
  };

  const endpoint = Far('SpikeEndpoint', {
    incarnation: () => incarnation,
    /** @param {unknown} x */
    echo: x => x,
    hang: () => new Promise(() => {}),
    /** @param {any} obj */
    see,
    /** @param {{ obj: any }} record */
    seeRecord: record => see(record.obj),
    seenStats: () => harden({ distinct, sightings, incarnation }),
    /**
     * The S9 effect: one fsynced line per run, then answer.
     * @param {string} id
     * @param {string} logPath
     */
    effect: (id, logPath) => {
      appendSynced(
        logPath,
        `${JSON.stringify({ id, incarnation, at: Date.now() })}\n`,
      );
      return id;
    },
    /** @param {any} other */
    connect: other => {
      peer = other;
      return true;
    },
    /**
     * n answered hops to the peer endpoint, timed here.
     * @param {number} n
     * @param {string} [payload]
     */
    hop: async (n, payload = '') => {
      const samples = [];
      const t0 = performance.now();
      for (let i = 0; i < n; i += 1) {
        const t1 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await E(peer).echo(payload);
        samples.push(performance.now() - t1);
      }
      return harden({
        ...summary(samples),
        totalMs: +(performance.now() - t0).toFixed(1),
      });
    },
    /**
     * n sendOnly events to the peer's take(); the peer counts them.
     * @param {number} n
     * @param {string} payload
     */
    pushTo: (n, payload) => {
      for (let i = 0; i < n; i += 1) E.sendOnly(peer).take(i, payload);
      return n;
    },
    /**
     * @param {number} _i
     * @param {string} s
     */
    take: (_i, s) => {
      const now = performance.now();
      if (receivedEvents === 0) firstAt = now;
      lastAt = now;
      receivedEvents += 1;
      receivedBytes += s.length;
      if (waiter && receivedEvents >= waiter.target) {
        waiter.resolve(
          harden({
            events: receivedEvents,
            bytes: receivedBytes,
            spanMs: +(lastAt - firstAt).toFixed(1),
          }),
        );
        waiter = undefined;
      }
    },
    resetReceived: () => {
      receivedEvents = 0;
      receivedBytes = 0;
      return true;
    },
    received: () =>
      harden({ events: receivedEvents, bytes: receivedBytes, incarnation }),
    /** @param {number} target */
    waitReceived: target =>
      new Promise(resolve => {
        if (receivedEvents >= target) {
          resolve(
            harden({
              events: receivedEvents,
              bytes: receivedBytes,
              spanMs: +(lastAt - firstAt).toFixed(1),
            }),
          );
          return;
        }
        waiter = { target, resolve, t0: performance.now() };
      }),
    /**
     * n answered round trips adapter -> vat -> adapter, timed here.
     * @param {any} vatObj
     * @param {number} n
     */
    pingVat: async (vatObj, n) => {
      const samples = [];
      for (let i = 0; i < n; i += 1) {
        const t1 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await E(vatObj).ping();
        samples.push(performance.now() - t1);
      }
      return summary(samples);
    },
  });

  const ops = Far('SpikeOps', {
    open: () => endpoint,
    /** @param {any} obj */
    see,
    /** @param {string} text */
    broadcast: text => {
      for (const listener of listeners.values())
        E.sendOnly(listener).hear(incarnation, text);
      return listeners.size;
    },
  });

  return makeAdapter({
    label: 'SpikeService',
    /**
     * @param {unknown} key
     * @param {any} spec
     */
    bind: async (key, spec) => {
      if (key === 'service') {
        await E(spec.sink).attach(ops, incarnation);
        return harden({ key });
      }
      listeners.set(key, spec.listener);
      E.sendOnly(spec.listener).bound(key, incarnation);
      return harden({ key });
    },
    /**
     * @param {unknown} _binding
     * @param {unknown} key
     */
    unbind: (_binding, key) => {
      listeners.delete(key);
    },
  });
};
harden(make);
