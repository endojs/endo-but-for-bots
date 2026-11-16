// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { RemoteControl, RemoteControlState, EndoGateway } from './types.js' */

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
     * Only the current state may retire this controller. Old transport
     * cancellations must not evict a replacement connection for the same peer.
     * @param {RemoteControlState} observedState
     * @param {Promise<never>} cancelled
     */
    const observeDisconnect = (observedState, cancelled) => {
      cancelled.catch(() => {
        if (state !== observedState) return;
        stateName = 'start';
        state = start();
        if (remoteControls.get(remoteNodeId) === control) {
          remoteControls.delete(remoteNodeId);
        }
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
     * ) => RemoteControlState}
     */
    const accepted = (remoteGateway, cancelCurrent, currentCancelled) => {
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
          cancelCurrent(
            new Error('Connection replaced by new inbound connection.'),
          );
          proposedCancelled.catch(() => {}).then(proposedDispose);
          return accepted(
            proposedRemoteGateway,
            proposedCancel,
            proposedCancelled,
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
          currentCancelled.catch(proposedCancel).then(proposedDispose);
          proposedCancelled.catch(() => {});
          return {
            state: accepted(remoteGateway, cancelCurrent, currentCancelled),
            remoteGateway,
          };
        },
      };

      observeDisconnect(acceptedState, currentCancelled);

      stateName = 'accepted';
      return acceptedState;
    };

    // We have an active outbound connection.
    /**
     * @type {(
     *   remoteGateway: ERef<EndoGateway>,
     *   cancel: (error: Error) => void,
     *   cancelled: Promise<never>,
     * ) => RemoteControlState}
     */
    const connected =
      localNodeId > remoteNodeId
        ? (remoteGateway, cancelCurrent, currentCancelled) => {
            // We are biased toward preserving our own outbound connection.
            /** @type {RemoteControlState} */
            const connectedState = {
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
                Promise.all([
                  proposedCancelled.catch(cancelCurrent),
                  currentCancelled.catch(proposedCancel),
                ])
                  .then(() => {})
                  .then(proposedDispose);
                return {
                  state: connected(
                    remoteGateway,
                    proposedCancel,
                    proposedCancelled,
                  ),
                  remoteGateway,
                };
              },
            };
            observeDisconnect(connectedState, currentCancelled);
            return connectedState;
          }
        : (remoteGateway, cancelCurrent, currentCancelled) => {
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
                Promise.all([
                  proposedCancelled.catch(cancelCurrent),
                  currentCancelled.catch(proposedCancel),
                ])
                  .then(() => {})
                  .then(proposedDispose);
                return {
                  state: connected(
                    remoteGateway,
                    proposedCancel,
                    proposedCancelled,
                  ),
                  remoteGateway,
                };
              },
            };
            observeDisconnect(connectedState, currentCancelled);
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
          const connectedState = connected(
            remoteGateway,
            cancelCurrent,
            currentCancelled,
          );
          stateName = 'connected';
          currentCancelled.catch(() => {}).then(currentDispose);
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

    const control = harden({ accept, connect, getStateName });
    return control;
  };

  /** @param {string} remoteNodeId */
  const provideActiveControl = remoteNodeId => {
    let remoteControl = remoteControls.get(remoteNodeId);
    if (remoteControl === undefined) {
      remoteControl = makeRemoteControl(remoteNodeId);
      remoteControls.set(remoteNodeId, remoteControl);
    }
    return remoteControl;
  };

  /**
   * Handles do not own a controller or occupy a permanent cache entry. Every
   * operation resolves the currently active controller, so a retained old
   * handle remains coherent with new handles after disconnection and eviction.
   * @param {string} remoteNodeId
   * @returns {RemoteControl}
   */
  const provideRemoteControl = remoteNodeId =>
    harden({
      accept(...args) {
        return provideActiveControl(remoteNodeId).accept(...args);
      },
      connect(...args) {
        const control = provideActiveControl(remoteNodeId);
        try {
          return control.connect(...args);
        } finally {
          // A synchronous dial failure never leaves an idle controller cached.
          if (
            control.getStateName() === 'start' &&
            remoteControls.get(remoteNodeId) === control
          ) {
            remoteControls.delete(remoteNodeId);
          }
        }
      },
      getStateName: () =>
        remoteControls.get(remoteNodeId)?.getStateName() || 'start',
    });

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

  return harden(provideRemoteControl);
};
harden(makeRemoteControlProvider);
