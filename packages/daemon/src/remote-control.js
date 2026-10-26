// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { RemoteControl, RemoteControlState, EndoGateway } from './types.js' */

/** @typedef {{ follow: (cancelled: Promise<never>, gateway: ERef<EndoGateway>) => void, add: (dispose?: () => void) => void, isEstablished: () => boolean }} ConnectionLifetime */

/** @param {string} id */
const short = id => id.slice(0, 8);

/**
 * @param {string} localNodeId
 */
export const makeRemoteControlProvider = localNodeId => {
  /** @type {Map<string, RemoteControl>} */
  const remoteControls = new Map();

  /** @param {string} remoteNodeId */
  const makeRemoteControl = remoteNodeId => {
    /** @type {RemoteControlState} */
    let state;
    let stateName = 'start';
    const tag = `${short(localNodeId)}→${short(remoteNodeId)}`;

    /**
     * Pending crossed hellos can transfer peer incarnations to the winning
     * transport. Once a gateway is established, replacing it must revoke the
     * old peer incarnations and their remote presences.
     * @param {Promise<never>} initialCancelled
     * @param {ERef<EndoGateway>} initialGateway
     * @returns {ConnectionLifetime}
     */
    const makeConnectionLifetime = (initialCancelled, initialGateway) => {
      /** @type {Promise<never> | undefined} */
      let observed;
      /** @type {ERef<EndoGateway> | undefined} */
      let observedGateway;
      let established = false;
      let ended = false;
      /** @type {Set<() => void>} */
      const disposals = new Set();
      /**
       * @param {Promise<never>} cancelled
       * @param {ERef<EndoGateway>} gateway
       */
      const follow = (cancelled, gateway) => {
        if (observedGateway !== gateway) {
          observedGateway = gateway;
          established = false;
          Promise.resolve(gateway).then(
            () => {
              if (observedGateway === gateway) established = true;
            },
            () => {},
          );
        }
        if (observed === cancelled) return;
        observed = cancelled;
        ended = false;
        cancelled.catch(() => {
          if (observed !== cancelled) return;
          ended = true;
          const ending = [...disposals];
          disposals.clear();
          // Reset the state before disposal callbacks can reenter connect.
          for (const dispose of ending) Promise.resolve().then(dispose);
        });
      };
      follow(initialCancelled, initialGateway);
      return harden({
        follow,
        isEstablished: () => established,
        add: dispose => {
          if (!dispose) return;
          if (ended) Promise.resolve().then(dispose);
          else disposals.add(dispose);
        },
      });
    };

    // In this state, we have received a remoteGateway from an ingress
    // connection (and provided our local gateway to them.)
    // We do not have a pending outbound connection attempt.
    /**
     * @type {(
     *   remoteGateway: ERef<EndoGateway>,
     *   cancel: (error: Error) => void | Promise<void>,
     *   cancelled: Promise<never>,
     *   lifetime?: ConnectionLifetime,
     * ) => RemoteControlState}
     */
    const accepted = (
      remoteGateway,
      cancelCurrent,
      currentCancelled,
      lifetime = makeConnectionLifetime(currentCancelled, remoteGateway),
    ) => {
      lifetime.follow(currentCancelled, remoteGateway);
      /** @type {import('./types.js').RemoteControlState} */
      const acceptedState = {
        accept(
          proposedRemoteGateway,
          proposedCancel,
          proposedCancelled,
          proposedDispose,
        ) {
          // And we receive an inbound connection.
          // There are two possibilities:
          // The sender raced multiple outbound connections and this connection
          // lost the race.
          // Or, the sender restarted but left a prior connection half-open.
          // We consider the race to be the common consideration and that
          // replacing peers after establishing a connection would be far to
          // disruptive.
          // TODO: For the case where we leave a peer wedged half-open, we
          // will need health checks.
          console.log(
            `Endo remote-control ${tag}: accepted→accepted (replacing connection)`,
          );
          const nextLifetime = lifetime.isEstablished()
            ? makeConnectionLifetime(proposedCancelled, proposedRemoteGateway)
            : lifetime;
          nextLifetime.follow(proposedCancelled, proposedRemoteGateway);
          cancelCurrent(
            new Error('Connection replaced by new inbound connection.'),
          );
          proposedCancelled.catch(() => {}).then(proposedDispose);
          return accepted(
            proposedRemoteGateway,
            proposedCancel,
            proposedCancelled,
            nextLifetime,
          );
        },
        connect(
          _getProposedRemoteGateway,
          proposedCancel,
          proposedCancelled,
          proposedDispose,
        ) {
          // Use the gateway we already have.
          // The inbound connection can outlive this proposed outbound peer
          // incarnation.  Losing the connection must dispose that
          // incarnation, but disposing an unused dial attempt must not close
          // the accepted transport.
          lifetime.add(proposedDispose);
          currentCancelled.catch(proposedCancel);
          proposedCancelled.catch(() => {});
          return {
            state: accepted(
              remoteGateway,
              cancelCurrent,
              currentCancelled,
              lifetime,
            ),
            remoteGateway,
          };
        },
      };

      currentCancelled.catch(() => {
        if (state === acceptedState) {
          console.log(
            `Endo remote-control ${tag}: accepted→start (connection lost)`,
          );
          stateName = 'start';
          state = start();
        }
      });

      stateName = 'accepted';
      return acceptedState;
    };

    // We have an active outbound connection.
    /**
     * @type {(
     *   remoteGateway: ERef<EndoGateway>,
     *   cancel: (error: Error) => void,
     *   cancelled: Promise<never>,
     *   lifetime: ConnectionLifetime,
     * ) => RemoteControlState}
     */
    const makeConnectedState =
      localNodeId > remoteNodeId
        ? (remoteGateway, cancelCurrent, currentCancelled, lifetime) => {
            // We are biased toward preserving our own outbound connection.
            return {
              accept(
                _proposedRemoteGateway,
                proposedCancel,
                _proposedCancelled,
                proposedDispose,
              ) {
                // We receive an inbound connection.
                // We favor our outbound connection,
                // so cancel the inbound.
                console.log(
                  `Endo remote-control ${tag}: connected, rejecting inbound (connect bias)`,
                );
                Promise.resolve(
                  proposedCancel(
                    new Error(
                      'Connection refused: already connected (crossed hellos, connect bias)',
                    ),
                  ),
                ).then(proposedDispose);
                return connected(
                  remoteGateway,
                  cancelCurrent,
                  currentCancelled,
                  lifetime,
                );
              },
              connect(
                _getProposedRemoteGateway,
                proposedCancel,
                proposedCancelled,
                proposedDispose,
              ) {
                // The corresponding peer is incarnated.
                // Bind the fates of this incarnation with the existing connection.
                lifetime.add(proposedDispose);
                Promise.all([
                  proposedCancelled.catch(cancelCurrent),
                  currentCancelled.catch(proposedCancel),
                ]).then(() => {});
                return {
                  state: connected(
                    remoteGateway,
                    proposedCancel,
                    proposedCancelled,
                    lifetime,
                  ),
                  remoteGateway,
                };
              },
            };
          }
        : (remoteGateway, cancelCurrent, currentCancelled, lifetime) => {
            // We are biased toward preserving inbound connections.
            /** @type {import('./types.js').RemoteControlState} */
            const connectedState = {
              accept(
                proposedRemoteGateway,
                proposedCancel,
                proposedCancelled,
                proposedDispose,
              ) {
                // We receive an inbound connection.
                // Ditch our outbound connection.
                console.log(
                  `Endo remote-control ${tag}: connected→accepted (accept bias, replacing outbound)`,
                );
                const nextLifetime = lifetime.isEstablished()
                  ? makeConnectionLifetime(
                      proposedCancelled,
                      proposedRemoteGateway,
                    )
                  : lifetime;
                nextLifetime.follow(proposedCancelled, proposedRemoteGateway);
                cancelCurrent(
                  new Error(
                    'Connection abandoned: accepted new connection (crossed hellos, accept bias)',
                  ),
                );
                proposedCancelled.catch(() => {}).then(proposedDispose);
                return accepted(
                  proposedRemoteGateway,
                  proposedCancel,
                  proposedCancelled,
                  nextLifetime,
                );
              },
              connect(
                _getProposedRemoteGateway,
                proposedCancel,
                proposedCancelled,
                proposedDispose,
              ) {
                // We incarnate the corresponding peer.
                // Bind the fates of the new peer with the existing connection.
                lifetime.add(proposedDispose);
                Promise.all([
                  proposedCancelled.catch(cancelCurrent),
                  currentCancelled.catch(proposedCancel),
                ]).then(() => {});
                return {
                  state: connected(
                    remoteGateway,
                    proposedCancel,
                    proposedCancelled,
                    lifetime,
                  ),
                  remoteGateway,
                };
              },
            };
            return connectedState;
          };

    /**
     * Every connected incarnation owns its cancellation observer. Reusing the
     * gateway still creates a new state, so an observer attached only by
     * start.connect would stop resetting after the first reuse. The identity
     * guard keeps a superseded transport from resetting its replacement.
     * @param {ERef<EndoGateway>} remoteGateway
     * @param {(error: Error) => void} cancelCurrent
     * @param {Promise<never>} currentCancelled
     * @param {ConnectionLifetime} lifetime
     * @returns {RemoteControlState}
     */
    const connected = (
      remoteGateway,
      cancelCurrent,
      currentCancelled,
      lifetime,
    ) => {
      lifetime.follow(currentCancelled, remoteGateway);
      const connectedState = makeConnectedState(
        remoteGateway,
        cancelCurrent,
        currentCancelled,
        lifetime,
      );
      currentCancelled.catch(() => {
        if (state === connectedState) {
          stateName = 'start';
          state = start();
        }
      });
      stateName = 'connected';
      return connectedState;
    };

    /** @type {() => RemoteControlState} */
    const start = () => {
      /** @type {import('./types.js').RemoteControlState} */
      const startState = {
        accept(
          proposedRemoteGateway,
          cancelCurrent,
          currentCancelled,
          currentDispose,
        ) {
          currentCancelled.catch(() => {}).then(currentDispose);
          return accepted(
            proposedRemoteGateway,
            cancelCurrent,
            currentCancelled,
          );
        },
        connect(
          getRemoteGateway,
          cancelCurrent,
          currentCancelled,
          currentDispose,
        ) {
          const remoteGateway = getRemoteGateway();
          const lifetime = makeConnectionLifetime(
            currentCancelled,
            remoteGateway,
          );
          lifetime.add(currentDispose);
          const connectedState = connected(
            remoteGateway,
            cancelCurrent,
            currentCancelled,
            lifetime,
          );
          return {
            state: connectedState,
            remoteGateway,
          };
        },
      };
      return startState;
    };

    state = start();

    /**
     * @param {ERef<EndoGateway>} proposedRemoteGateway
     * @param {(error: Error) => void} cancelConnection
     * @param {Promise<never>} connectionCancelled
     * @param {() => void} connectionDispose
     */
    const accept = (
      proposedRemoteGateway,
      cancelConnection,
      connectionCancelled,
      connectionDispose,
    ) => {
      console.log(`Endo remote-control ${tag}: accept (was ${stateName})`);
      state = state.accept(
        proposedRemoteGateway,
        cancelConnection,
        connectionCancelled,
        connectionDispose || (() => {}),
      );
    };
    /**
     * @param {() => ERef<EndoGateway>} getRemoteGateway
     * @param {(error: Error) => void} cancelIncarnation
     * @param {Promise<never>} incarnationCancelled
     * @param {() => void} disposeIncarnation
     */
    const connect = (
      getRemoteGateway,
      cancelIncarnation,
      incarnationCancelled,
      disposeIncarnation,
    ) => {
      console.log(`Endo remote-control ${tag}: connect (was ${stateName})`);
      const { state: nextState, remoteGateway } = state.connect(
        getRemoteGateway,
        cancelIncarnation,
        incarnationCancelled,
        disposeIncarnation,
      );
      state = nextState;
      return remoteGateway;
    };

    const getStateName = () => stateName;

    return { accept, connect, getStateName };
  };

  /** @param {string} remoteNodeId */
  const provideRemoteControl = remoteNodeId => {
    let remoteControl = remoteControls.get(remoteNodeId);
    if (remoteControl === undefined) {
      remoteControl = makeRemoteControl(remoteNodeId);
      remoteControls.set(remoteNodeId, remoteControl);
    }
    return remoteControl;
  };

  /**
   * @returns {Record<string, string>} Map of nodeId to state name
   */
  const getConnectionStates = () => {
    /** @type {Record<string, string>} */
    const states = {};
    for (const [nodeId, control] of remoteControls.entries()) {
      states[nodeId] = control.getStateName();
    }
    return states;
  };

  provideRemoteControl.getConnectionStates = getConnectionStates;

  return provideRemoteControl;
};
