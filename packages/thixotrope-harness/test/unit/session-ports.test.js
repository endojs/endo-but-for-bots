// @ts-check
// The ports of the current adapter incarnation (guest/session/ports.js),
// at its interface: one open in flight at a time; fresh ports held with
// their tool set; ports of the incarnation whose lease broke asked for
// again at most 3 opens in a row, then the open failed; a rejection; each
// answer's crank flushed; drop and publisherBroke.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { makePorts } from '../../guest/session/ports.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const drain = () => new Promise(resolve => setImmediate(resolve));

const setup = () => {
  /** @type {any[]} */
  const opens = [];
  /** @type {any[]} */
  const log = [];
  const backend = Far('Backend', {
    open: () => {
      const kit = makePromiseKit();
      opens.push(kit);
      return kit.promise;
    },
  });
  const live = /** @type {any} */ ({
    forget: (/** @type {any} */ publisher) => log.push(['forget', publisher]),
  });
  const ports = makePorts({
    services: { backend, host: Far('Host', {}) },
    live,
    toolsFor: p => harden({ for: p.since }),
    onFresh: (set, since) => log.push(['fresh', set.tools.for, since]),
    onFailed: error => log.push(['failed', /** @type {Error} */ (error).message]),
    flush: () => log.push(['flush']),
  });
  /** @param {number} since */
  const portsAt = since =>
    harden({ since, publisher: Far('LivePublisher', {}) });
  return { ports, opens, log, portsAt };
};

test('one open at a time; the answer is held with its tool set, then flushed', async t => {
  const { ports, opens, log, portsAt } = setup();
  ports.open();
  ports.open();
  await drain();
  t.is(opens.length, 1);
  const first = portsAt(10);
  opens[0].resolve(first);
  await drain();
  t.deepEqual(log, [['fresh', 10, 10], ['flush']]);
  t.is(ports.held()?.ports, first);
  t.deepEqual(ports.held()?.tools, { for: 10 });
  ports.drop(first);
  t.is(ports.held(), undefined);
  t.deepEqual(log[2], ['forget', first.publisher]);
});

test('after a break, stale answers are asked again at most 3 opens in a row', async t => {
  const { ports, opens, log, portsAt } = setup();
  ports.open();
  await drain();
  const dead = portsAt(10);
  opens[0].resolve(dead);
  await drain();
  log.length = 0;
  ports.broke(dead);
  await drain();
  opens[1].resolve(portsAt(10));
  await drain();
  opens[2].resolve(portsAt(9));
  await drain();
  t.is(opens.length, 4, 'two stale answers asked again');
  opens[3].resolve(portsAt(10));
  await drain();
  t.deepEqual(log, [
    ['flush'],
    ['flush'],
    ['failed', 'the backend answered with ports that are gone'],
    ['flush'],
  ]);
  log.length = 0;
  ports.open();
  await drain();
  opens[4].resolve(portsAt(20));
  await drain();
  t.deepEqual(log, [['fresh', 20, 20], ['flush']]);
});

test('a rejected open fails; an outside break drops held ports unless in use', async t => {
  const { ports, opens, log, portsAt } = setup();
  ports.open();
  await drain();
  opens[0].reject(Error('no backend'));
  await drain();
  t.deepEqual(log, [['failed', 'no backend'], ['flush']]);
  ports.open();
  await drain();
  const held = portsAt(30);
  opens[1].resolve(held);
  await drain();
  ports.publisherBroke(Far('LivePublisher', {}), undefined);
  t.is(ports.held()?.ports, held, 'another publisher: kept');
  ports.publisherBroke(held.publisher, held);
  t.is(ports.held()?.ports, held, 'the current turn uses them: kept');
  ports.publisherBroke(held.publisher, undefined);
  t.is(ports.held(), undefined);
});
