// @ts-check
/** @import { E as EType, Far as FarType } from '@endo/far' */
const { E, Far } =
  /** @type {typeof globalThis & {E: typeof EType, Far: typeof FarType}} */ (
    globalThis
  );

/** @param {{http: any}} powers */
export const make = ({ http }) => {
  let count = 0n;
  const handler = Far('CounterHttpHandler', {
    /** @param {{method: string, path: string}} request */
    handle: ({ method, path }) => {
      if (method === 'POST' && path === '/incr') count += 1n;
      else if (method !== 'GET' || path !== '/read')
        return harden({ status: 404, body: 'GET /read or POST /incr\n' });
      return harden({ status: 200, body: `${count}\n` });
    },
  });
  let registration;
  return Far('HttpCounterApplication', {
    help: () =>
      'start(port) registers HTTP, status() inspects it, read() returns the count, and close() stops serving.',
    /** @param {number} port */
    start: async port => {
      registration = await E(http).register(port, handler);
      return E(registration).status();
    },
    read: () => count,
    status: () => E(registration).status(),
    close: () => E(registration).close(),
  });
};
harden(make);
