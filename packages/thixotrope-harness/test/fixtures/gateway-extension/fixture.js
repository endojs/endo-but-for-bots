// @ts-check
/**
 * A fixture gateway extension (M3 W3.2; designs/m3-interfaces.md 6.1,
 * acceptance 16). Tests load it from this directory, or copy it into
 * `resources/agent-host/impl/gateway/extensions/` and remove it after. It
 * imports nothing (it must work from either place) and reads the guest
 * prelude off `globalThis`, as the adapter has it.
 *
 * It adds: a service `fixture` in `GatewayPowers.extras` (`ping()`;
 * `sameWriter(writer)`, true when `writer` is the incarnation's
 * `context.secretWriter()`, compared by identity in the adapter); an HTTP
 * route `/fixture`; a CSP source; and a large-call exemption for its own
 * service's `echoLarge`.
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { GatewayContext, GatewayExtension } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

const { M, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** @type {Map<GatewayContext, any>} one service per incarnation */
const services = new Map();

/** @param {GatewayContext} context */
const serviceFor = context => {
  if (!services.has(context)) {
    services.set(
      context,
      makeExo(
        'FixtureService',
        M.interface('FixtureService', {
          ping: M.call().returns(M.string()),
          sameWriter: M.callWhen(M.remotable('SecretWriter')).returns(
            M.boolean(),
          ),
          echoLarge: M.call(M.string({ stringLengthLimit: 1_048_576 })).returns(
            M.number(),
          ),
        }),
        {
          ping: () => 'pong',
          /** @param {unknown} writer */
          sameWriter: writer =>
            context.secretWriter().then(own => own === writer),
          /** @param {string} text */
          echoLarge: text => text.length,
        },
      ),
    );
  }
  return services.get(context);
};

/** @type {GatewayExtension} */
export const gatewayExtension = {
  name: 'fixture',
  services: [{ label: 'fixture', make: serviceFor }],
  routes: [
    {
      kind: 'http',
      path: '/fixture',
      handle: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('fixture route');
      },
    },
  ],
  largeCalls: [
    { target: async context => serviceFor(context), methods: ['echoLarge'] },
  ],
  csp: { 'img-src': ['blob:'] },
};
