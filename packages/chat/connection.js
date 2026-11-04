// @ts-check
import { connectApplication } from '@endo/browser-endo/application.js';
import { noteDecodedErrorId } from '@endo/spaces-util/error-trace.js';

/** Chat consumes the shared application runtime, with an explicitly named agent.
 * @param {{gateway?: string, agent?: string, relay?: string, relayDomain?: string, endowments?: Record<string, string>}} config
 */
export const connectToGateway = config => {
  const connection = connectApplication(
    {
      ...config,
      endowments: config.endowments || { agent: config.agent || '' },
    },
    {
      capTpOptions: {
        marshalLoadError: (error, id) => noteDecodedErrorId(error, id),
      },
    },
  );
  return harden({
    powers: connection.endowments.then(endowments => {
      if (!Object.hasOwn(endowments, 'agent'))
        throw new Error('Chat requires an agent endowment');
      return endowments.agent;
    }),
    close: connection.close,
    closed: connection.closed,
  });
};
harden(connectToGateway);

export const connectToHubCap = connectToGateway;
harden(connectToHubCap);
