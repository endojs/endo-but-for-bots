// @ts-nocheck
/* eslint-disable max-classes-per-file, class-methods-use-this -- interop suite mirrors capnweb's RpcTarget idiom */
// MessagePort interop against a real cloudflare/capnweb session.  capnweb's
// MessagePort transport uses the "structuredClonable" encoding level
// (capnweb >= 0.9.0): it posts live message objects with native bigint /
// Date / undefined / Uint8Array rather than JSON strings.  These tests drive
// the endo MessagePort transport against capnweb's newMessagePortRpcSession
// over a real node:worker_threads MessageChannel, exercising the
// structured-clonable bridging in src/transports/message-port.js.

import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/pass-style';
import { E } from '@endo/eventual-send';
import { MessageChannel } from 'node:worker_threads';

import {
  makeCapnWebSession,
  makeMessagePortTransport,
} from '../../src/index.js';

let capnweb;
try {
  capnweb = await import('capnweb');
} catch (_e) {
  capnweb = null;
}
const interop = capnweb ? test : test.skip;

interop(
  'endo MessagePort client → capnweb server: calls and special values',
  async t => {
    t.timeout(20_000);
    const { port1, port2 } = new MessageChannel();
    class Main extends capnweb.RpcTarget {
      add(a, b) {
        return a + b;
      }
      echo(x) {
        return x;
      }
    }
    // capnweb serves Main over its structured-clonable MessagePort transport.
    capnweb.newMessagePortRpcSession(port2, new Main());
    const endo = makeCapnWebSession(makeMessagePortTransport(port1), {
      gcImports: false,
    });
    t.teardown(() => {
      endo.abort();
      port1.close();
      port2.close();
    });
    const r = endo.getRemoteMain();

    t.is(await E(r).add(40, 2), 42);
    // Values capnweb sends back natively over structured clone: bigint, Date,
    // undefined, Uint8Array (as ["bytes", <Uint8Array>]), and non-finite
    // numbers — each must survive the transport's native→tuple bridging.
    t.is(
      await E(r).echo(123_456_789_012_345_678_901n),
      123_456_789_012_345_678_901n,
    );
    const d = new Date(1_700_000_000_123);
    t.is((await E(r).echo(d)).getTime(), d.getTime());
    t.is(await E(r).echo(undefined), undefined);
    const bytes = await E(r).echo(new Uint8Array([1, 2, 250, 0, 255]));
    t.deepEqual(Array.from(bytes), [1, 2, 250, 0, 255]);
    t.true(Number.isNaN(await E(r).echo(NaN)));
    t.is(await E(r).echo(Infinity), Infinity);
    // A structure mixing native leaves round-trips too.
    const back = await E(r).echo({
      when: d,
      count: 7n,
      data: new Uint8Array([9, 8]),
      note: 'ok',
    });
    t.is(back.when.getTime(), d.getTime());
    t.is(back.count, 7n);
    t.deepEqual(Array.from(back.data), [9, 8]);
    t.is(back.note, 'ok');
  },
);

interop(
  'capnweb MessagePort client → endo server: calls and special values',
  async t => {
    t.timeout(20_000);
    const { port1, port2 } = new MessageChannel();
    const endo = makeCapnWebSession(makeMessagePortTransport(port1), {
      localMain: Far('main', {
        add: (a, b) => a + b,
        echo: x => x,
      }),
      gcImports: false,
    });
    class Empty extends capnweb.RpcTarget {}
    const r = capnweb.newMessagePortRpcSession(port2, new Empty());
    t.teardown(() => {
      endo.abort();
      port1.close();
      port2.close();
    });

    t.is(await r.add(40, 2), 42);
    // endo sends its JSON tuple forms as posted objects; capnweb's
    // structured-clonable evaluator accepts them at every encoding level.
    t.is(await r.echo(123n), 123n);
    const d = new Date(1_700_000_000_456);
    t.is((await r.echo(d)).getTime(), d.getTime());
    t.is(await r.echo(undefined), undefined);
    const bytes = await r.echo(new Uint8Array([5, 6, 7, 200]));
    t.deepEqual(Array.from(bytes), [5, 6, 7, 200]);
    t.true(Number.isNaN(await r.echo(NaN)));
  },
);

interop(
  'endo MessagePort ↔ capnweb: capability passing and pipelining',
  async t => {
    t.timeout(20_000);
    const { port1, port2 } = new MessageChannel();
    class Counter extends capnweb.RpcTarget {
      constructor() {
        super();
        this.n = 0;
      }
      incr(by) {
        this.n += by;
        return this.n;
      }
    }
    class Main extends capnweb.RpcTarget {
      make() {
        return new Counter();
      }

      async use(helper, x) {
        return helper.square(x);
      }
    }
    capnweb.newMessagePortRpcSession(port2, new Main());
    const endo = makeCapnWebSession(makeMessagePortTransport(port1), {
      gcImports: false,
    });
    t.teardown(() => {
      endo.abort();
      port1.close();
      port2.close();
    });
    const r = endo.getRemoteMain();

    // Pipeline: make() then incr() without awaiting the intermediate.
    const c = await E(r).make();
    t.is(await E(c).incr(5), 5);
    t.is(await E(c).incr(3), 8);

    // Endo capability used by capnweb during a call.
    const helper = Far('helper', { square: x => x * x });
    t.is(await E(r).use(helper, 9), 81);
  },
);
