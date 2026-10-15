// @ts-check
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, makeExo, M } = /** @type {GuestGlobals} */ (globalThis);

const HandlerI = M.interface('CounterHttpHandler', {
  handle: M.call(
    M.splitRecord(
      { method: M.string(), path: M.string() },
      { body: M.opt(M.string()) },
    ),
  ).returns(M.splitRecord({ status: M.number(), body: M.string() })),
});

const ApplicationI = M.interface('HttpCounterApplication', {
  help: M.call().returns(M.string()),
  start: M.call(M.number()).returns(M.promise()),
  read: M.call().returns(M.bigint()),
  status: M.call().returns(M.promise()),
  close: M.call().returns(M.promise()),
});

/** @param {{http: any}} powers */
export const make = ({ http }) => {
  let count = 0n;
  const handler = makeExo('CounterHttpHandler', HandlerI, {
    /** @param {{method: string, path: string}} request */
    handle: ({ method, path }) => {
      if (method === 'POST' && path === '/incr') count += 1n;
      else if (method !== 'GET' || path !== '/read')
        return harden({ status: 404, body: 'GET /read or POST /incr\n' });
      return harden({ status: 200, body: `${count}\n` });
    },
  });
  let registration;
  return makeExo('HttpCounterApplication', ApplicationI, {
    help: () =>
      'start(port) registers HTTP, status() inspects it, read() returns the count, and close() stops serving.',
    /** @param {number} port */
    start: async port => {
      // Moving ports releases the old registration first; a handle nobody
      // holds would keep serving until the manager was asked to close it.
      if (registration !== undefined) await E(registration).close();
      registration = await E(http).register(port, handler);
      return E(registration).status();
    },
    read: () => count,
    status: () => E(registration).status(),
    close: () => E(registration).close(),
  });
};
harden(make);
