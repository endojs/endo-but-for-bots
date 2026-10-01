// @ts-check

// Guest-scoped bootstraps (designs/endo-guest-stdio-mcp.md § How the
// confinement properties change, shape 1).
//
// The daemon's private socket bootstraps to the root `Endo` object, whose
// `host()` carries the whole host's authority. A harness that should speak for
// exactly one guest instead connects to a socket this module serves for that
// guest: the CapTP bootstrap (export offset 0) on that socket IS the guest
// facet, so the connection reaches that guest and nothing else.

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { servePrivatePath } from './serve-private-path.js';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { SocketPowers } from './types.js' */

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
  /** @type {Map<string, string>} */
  const numberByName = new Map();
  /** @type {Promise<void> | undefined} */
  let directoryReady;

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  /**
   * @param {string} formulaNumber - the guest's 64-hex formula number.
   * @param {FarRef<unknown> | object} guest - the guest facet to bootstrap to.
   * @returns {Promise<string>} the socket path.
   */
  const issue = (formulaNumber, guest) => {
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
    const issued = (async () => {
      if (directoryReady === undefined) {
        directoryReady = makePrivateDirectory(directory);
      }
      await directoryReady;
      const { started, stopped } = servePrivatePath(
        socketPath,
        /** @type {FarRef<unknown>} */ (guest),
        {
          servePath,
          connectionNumbers,
          cancelled,
          exitWithError: reportError,
          marshalSaveError,
        },
      );
      stopped.catch(reportError);
      await started;
      return socketPath;
    })();
    issuedByNumber.set(formulaNumber, issued);
    // A failed issue may be retried.
    issued.catch(() => {
      issuedByNumber.delete(formulaNumber);
      numberByName.delete(name);
    });
    return issued;
  };

  return harden({ issue });
};
harden(makeGuestPathIssuer);
