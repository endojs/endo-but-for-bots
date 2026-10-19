import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const RecordingNetworkInterface = M.interface('RecordingNetwork', {
  addresses: M.call().returns(M.arrayOf(M.string())),
  supports: M.call(M.string()).returns(M.boolean()),
  connect: M.call(M.string(), M.any()).returns(M.promise()),
  registerAgentKey: M.call(M.string(), M.string()).returns(),
  unregisterAgentKey: M.call(M.string()).returns(),
  registeredAgentKeys: M.call().returns(M.arrayOf(M.string())),
});

/**
 * A network that dials nothing and records the agent keys the daemon
 * registers with it.
 */
export const make = () => {
  /** @type {Map<string, string>} */
  const agentIdForKey = new Map();
  return makeExo('RecordingNetwork', RecordingNetworkInterface, {
    addresses: () => harden([]),
    supports: () => false,
    connect: async () => {
      throw Error('The recording network cannot connect');
    },
    registerAgentKey: (publicKey, agentId) => {
      agentIdForKey.set(publicKey, agentId);
    },
    unregisterAgentKey: publicKey => {
      agentIdForKey.delete(publicKey);
    },
    registeredAgentKeys: () => harden([...agentIdForKey.keys()]),
  });
};
