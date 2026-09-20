// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { encodeSwissnum } from '@endo/ocapn/client/util';

import { makeFirstFailure, makeInFlight } from '../in-flight.js';

/** @import { NativeWorkerPowers } from '../platform/node/native-workers.js' */
/** @import { RandomPowers } from '../platform/random.js' */

/**
 * Each native incarnation is an ephemeral session: no heap or input replay.
 * @param {{nativeWorkers?: NativeWorkerPowers, random: RandomPowers}} powers
 * @param {{hub: any, importBootstrap: (id: string) => any}} options
 */
export const makeNativeAdapters = (
  { nativeWorkers, random },
  { hub, importBootstrap },
) => {
  const opening = makeInFlight();
  const cleanupFailure = makeFirstFailure();
  /** @type {Set<() => Promise<void>>} */
  const closers = new Set();
  let stopped = false;

  /** @param {any} description */
  const resource = description =>
    Far('NativeAdapterLauncher', {
      help: () =>
        'create() starts a fresh native adapter from this installation.',
      create: () =>
        opening.track(
          (async () => {
            if (stopped) throw Error('Native adapters are stopped');
            if (!nativeWorkers) throw Error('Native workers are unavailable');
            const id = `transient:native:${Array.from(random.randomBytes(16), b => b.toString(16).padStart(2, '0')).join('')}`;
            /** @type {any} */
            let sink;
            /** @type {Uint8Array[]} */
            const pending = [];
            let exited = false;
            const child = await nativeWorkers.start({
              id,
              moduleUrl: description.moduleUrl,
              packageIdentity: description.packageIdentity,
              onFrame: bytes => {
                if (exited) return;
                if (sink) sink.deliver(bytes);
                else pending.push(bytes);
              },
              onExit: () => {
                exited = true;
                pending.length = 0;
                try {
                  hub.forgetSession(id);
                } catch (error) {
                  cleanupFailure.record(error);
                }
              },
            });
            const close = async () => {
              try {
                await child.terminate();
              } finally {
                hub.forgetSession(id);
                closers.delete(close);
              }
            };
            closers.add(close);
            void child.closed.then(() => closers.delete(close));
            try {
              if (stopped || exited)
                throw Error('Native adapter stopped during startup');
              sink = hub.attachSession(id, {
                durable: false,
                send: child.send,
                onAbort: () => {
                  void close().catch(error => cleanupFailure.record(error));
                },
              });
              for (const bytes of pending.splice(0)) sink.deliver(bytes);
              const root = await E(importBootstrap(id)).fetch(
                encodeSwissnum('root'),
              );
              return Far('NativeAdapterIncarnation', {
                getRoot: () => root,
                retire: close,
              });
            } catch (error) {
              await close();
              throw error;
            }
          })(),
        ),
    });
  return harden({
    resource,
    shutdown: async () => {
      stopped = true;
      const results = await Promise.allSettled([
        ...[...closers].map(close => close()),
        opening.drain(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') cleanupFailure.record(result.reason);
      }
      cleanupFailure.assertNone();
    },
  });
};
harden(makeNativeAdapters);
