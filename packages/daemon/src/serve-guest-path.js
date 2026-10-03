// @ts-check

// Guest-scoped bootstraps (designs/endo-guest-stdio-mcp.md § How the
// confinement properties change, shape 1).
//
// The daemon's private socket bootstraps to the root `Endo` object, whose
// `host()` carries the whole host's authority. A harness that should speak for
// exactly one guest instead connects to a socket this module serves for that
// guest: the CapTP bootstrap (export offset 0) on that socket IS the guest
// facet, so the connection reaches that guest and nothing else.
// Revoking a guest's socket, as when the guest is cancelled or collected,
// closes the listener, removes the pathname, and ends every connection made
// on it. With formula collection off (no ENDO_GC=1), dropping a guest's last
// pet name neither collects nor cancels it, so its socket stays served.

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { servePrivatePath } from './serve-private-path.js';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { CapTpConnectionRegistrar, SocketPowers } from './types.js' */

// Darwin's sun_path holds 104 bytes including the terminator; Linux holds 108.
const MAX_SOCKET_PATH_LENGTH = 103;

// A socket name of 24 hex digits of the formula number keeps the path short
// enough for macOS's sun_path; two numbers sharing a prefix are refused below.
const SOCKET_NAME_DIGITS = 24;

/**
 * @param {object} powers
 * @param {string} powers.directory - where guest sockets are made; created
 *   with mode 0700 on first issue.
 * @param {(path: string) => string} powers.socketPathFor - joins a socket
 *   name onto `directory`.
 * @param {(directory: string) => Promise<void>} powers.makePrivateDirectory
 * @param {SocketPowers['servePath']} powers.servePath
 * @param {Promise<never>} powers.cancelled
 * @param {(error: Error) => void} powers.reportError
 * @param {(err: Error, errorId?: string) => void} [powers.marshalSaveError]
 */
export const makeGuestPathIssuer = ({
  directory,
  socketPathFor,
  makePrivateDirectory,
  servePath,
  cancelled,
  reportError,
  marshalSaveError,
}) => {
  /** @type {Map<string, Promise<string>>} */
  const issuedByNumber = new Map();
  /** @type {Map<string, (reason: Error) => void>} */
  const revokeByNumber = new Map();
  /** @type {Map<string, string>} */
  const numberByName = new Map();
  /** @type {Promise<void> | undefined} */
  let directoryReady;
  // Registered before any service races `cancelled`, so the flag is set
  // before a stopped service reports.
  let isDaemonCancelled = false;
  cancelled.catch(() => {
    isDaemonCancelled = true;
  });

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  /**
   * @param {string} formulaNumber
   * @param {string} name
   */
  const forget = (formulaNumber, name) => {
    issuedByNumber.delete(formulaNumber);
    revokeByNumber.delete(formulaNumber);
    numberByName.delete(name);
  };

  /**
   * @param {string} formulaNumber - the guest's 64-hex formula number.
   * @param {FarRef<unknown> | object} guest - the guest facet to bootstrap to.
   * @param {object} [options]
   * @param {CapTpConnectionRegistrar} [options.capTpConnectionRegistrar] -
   *   registers each connection with the daemon's residence tracker, as the
   *   root socket's connections are.
   * @returns {Promise<string>} the socket path.
   */
  const issue = (
    formulaNumber,
    guest,
    { capTpConnectionRegistrar = undefined } = {},
  ) => {
    const prior = issuedByNumber.get(formulaNumber);
    if (prior !== undefined) {
      return prior;
    }
    const name = `${formulaNumber.slice(0, SOCKET_NAME_DIGITS)}.sock`;
    const holder = numberByName.get(name);
    if (holder !== undefined && holder !== formulaNumber) {
      throw makeError(
        X`Guest socket name ${q(name)} is already issued to another guest`,
      );
    }
    const socketPath = socketPathFor(name);
    if (socketPath.length > MAX_SOCKET_PATH_LENGTH) {
      throw makeError(
        X`Guest socket path is too long for a Unix socket: ${q(socketPath)}`,
      );
    }
    numberByName.set(name, formulaNumber);
    const { promise: revoked, reject: rejectRevoked } =
      /** @type {import('@endo/promise-kit').PromiseKit<never>} */ (
        makePromiseKit()
      );
    revoked.catch(() => {});
    let isRevoked = false;
    /** @param {Error} reason */
    const revokeThis = reason => {
      isRevoked = true;
      rejectRevoked(reason);
    };
    revokeByNumber.set(formulaNumber, revokeThis);
    // Either the daemon stopping or the guest's revocation ends the service.
    const guestCancelled = /** @type {Promise<never>} */ (
      Promise.race([cancelled, revoked])
    );
    guestCancelled.catch(() => {});
    const issued = (async () => {
      if (directoryReady === undefined) {
        const making = makePrivateDirectory(directory);
        directoryReady = making;
        // A failed directory may be retried by the next issue, for any guest.
        making.catch(() => {
          if (directoryReady === making) {
            directoryReady = undefined;
          }
        });
      }
      await directoryReady;
      const { started, stopped } = servePrivatePath(
        socketPath,
        /** @type {FarRef<unknown>} */ (guest),
        {
          servePath,
          connectionNumbers,
          cancelled: guestCancelled,
          exitWithError: reportError,
          capTpConnectionRegistrar,
          marshalSaveError,
        },
      );
      stopped.catch(error => {
        // Revocation and daemon cancellation are deliberate stops, not
        // failures to report.
        if (!isRevoked && !isDaemonCancelled) reportError(error);
      });
      try {
        await started;
      } catch (error) {
        // The caller receives a startup failure, so the service need not
        // report it too; the flag is set before `stopped` reports.
        isRevoked = true;
        throw error;
      }
      return socketPath;
    })();
    issuedByNumber.set(formulaNumber, issued);
    // A failed issue may be retried.
    issued.catch(error => {
      if (issuedByNumber.get(formulaNumber) === issued) {
        forget(formulaNumber, name);
      }
      revokeThis(error);
    });
    return issued;
  };

  /**
   * Stop serving a guest's socket: refuse new connections, remove the
   * pathname, and close the connections already made. A guest that holds no
   * socket is ignored.
   *
   * @param {string} formulaNumber
   * @param {Error} reason - delivered to the guest's open connections.
   */
  const revoke = (formulaNumber, reason) => {
    const revokeGuest = revokeByNumber.get(formulaNumber);
    if (revokeGuest === undefined) return;
    // The name is freed now, but the listener removes the pathname later, as
    // its service stops; a same-prefix issue in between may find it present.
    forget(formulaNumber, `${formulaNumber.slice(0, SOCKET_NAME_DIGITS)}.sock`);
    revokeGuest(reason);
  };

  return harden({ issue, revoke });
};
harden(makeGuestPathIssuer);
