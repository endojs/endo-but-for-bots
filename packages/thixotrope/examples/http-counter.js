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
  // Return the application root without waiting for the host registration reply.
  // The service publication retains the handler; status exposes readiness.
  let registrationError;
  E(http)
    .listen(handler)
    .catch(error => {
      registrationError = String(error);
    });
  return Far('HttpCounterApplication', {
    help: () =>
      'status() inspects the HTTP listener, read() returns the persistent count, close() permanently closes the listener.',
    read: () => count,
    status: () => E(http).status(),
    registrationError: () => registrationError,
    close: () => E(http).close(),
  });
};
harden(make);
