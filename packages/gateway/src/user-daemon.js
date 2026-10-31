// @ts-check

/**
 * @file The per-user daemon's side of the gateway bootstrap channel
 *   (design Feature 4).
 *
 * `designs/gateway-package.md` splits a host into one gateway service
 * and many per-user daemons. The gateway owns the shared surface: the
 * public listener, `Host`-header routing, the registration table, and
 * the proof-of-possession check. Each per-user daemon keeps its own
 * private keys, weblet content, and request handling. `bootstrap.js`
 * implements the gateway half; this module implements the daemon half.
 *
 * `registerUserDaemon` runs the challenge-response handshake and
 * hands the gateway a `UserDaemon` callback exo. The gateway reaches
 * the daemon only through that exo, and the exo answers only for
 * weblets this daemon published through the same registration.
 *
 * The daemon recomputes the domain-separated nonce hash itself and
 * refuses a challenge whose `hashedNonce` disagrees. Without that
 * check, a hostile process listening on the bootstrap socket could
 * make the daemon sign arbitrary 32-byte messages with its OCapN key.
 */

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';

import {
  constantTimeEqual,
  hashNonceForSigning,
} from './proof-of-possession.js';

/** @import { CryptoPowers, GatewayBootstrap, PublicKeyAddition, Registration } from './types.js' */
/** @import { KeySigner, UserDaemonPublication, UserDaemonPublisher, UserDaemonRequest } from './types.js' */

const UserDaemonInterface = M.interface('GatewayUserDaemon', {
  handleHttp: M.call(M.string(), M.record()).returns(M.promise()),
  handleWebSocketUpgrade: M.call(M.string(), M.record()).returns(M.promise()),
  fetchContentTree: M.call(M.string()).returns(M.promise()),
});

const UserDaemonPublisherInterface = M.interface('GatewayUserDaemonPublisher', {
  publishWeblet: M.call(
    M.splitRecord({
      webletId: M.string(),
      contentTreeRoot: M.string(),
      hasWebSocket: M.boolean(),
      handler: M.remotable('WebletHandler'),
    }),
  ).returns(M.promise()),
  unpublishWeblet: M.call(M.string()).returns(M.promise()),
  addPublicKey: M.call(M.remotable('KeySigner')).returns(M.promise()),
  listWeblets: M.call().returns(M.promise()),
  getRegistration: M.call().returns(M.promise()),
  deregister: M.call().returns(M.promise()),
});

/**
 * Obtain a fresh challenge from the gateway and sign it, producing
 * the `{ publicKey, nonce, signature }` triple that `register` and
 * `addPublicKey` accept.
 *
 * @param {object} options
 * @param {GatewayBootstrap} options.bootstrap
 * @param {Pick<CryptoPowers, 'sha256'>} options.crypto
 * @param {KeySigner} options.signer
 * @returns {Promise<PublicKeyAddition>}
 */
export const proveKeyPossession = async ({ bootstrap, crypto, signer }) => {
  const { nonce, hashedNonce } = await E(bootstrap).challenge();
  const expected = hashNonceForSigning(
    nonce,
    /** @type {CryptoPowers} */ (crypto),
  );
  if (!constantTimeEqual(expected, hashedNonce)) {
    throw makeError(
      X`Gateway challenge hashedNonce does not match the domain-separated hash of its nonce; refusing to sign`,
    );
  }
  const [publicKey, signature] = await Promise.all([
    E(signer).getPublicKey(),
    E(signer).sign(expected),
  ]);
  return harden({ publicKey, nonce, signature });
};
harden(proveKeyPossession);

/**
 * Register a per-user daemon with the host gateway and return the
 * daemon-local publisher through which it publishes weblets.
 *
 * @param {object} options
 * @param {GatewayBootstrap} options.bootstrap The gateway's bootstrap exo,
 *   typically the CapTP bootstrap of the registrar socket.
 * @param {Pick<CryptoPowers, 'sha256'>} options.crypto
 * @param {KeySigner} options.signer The daemon's Ed25519 identity; its
 *   private key never leaves the daemon.
 * @param {Promise<unknown>} [options.cancelled] Settles when the
 *   connection to the gateway closes. When omitted, the registration
 *   lasts until `deregister()`.
 * @returns {Promise<UserDaemonPublisher>}
 */
export const registerUserDaemon = async ({
  bootstrap,
  crypto,
  signer,
  cancelled,
}) => {
  /** @type {Map<string, UserDaemonPublication>} */
  const publications = new Map();
  const cancelKit = makePromiseKit();
  if (cancelled !== undefined) {
    void Promise.resolve(cancelled).then(
      () => cancelKit.resolve(undefined),
      () => cancelKit.resolve(undefined),
    );
  }
  void cancelKit.promise.then(() => publications.clear());

  /** @param {string} webletId */
  const publicationFor = webletId => {
    const publication = publications.get(webletId);
    if (publication === undefined) {
      throw makeError(X`Weblet ${q(webletId)} is not published by this daemon`);
    }
    return publication;
  };

  const daemon = makeExo(
    'GatewayUserDaemon',
    UserDaemonInterface,
    /** @type {any} */ ({
      /**
       * @param {string} webletId
       * @param {UserDaemonRequest} request
       */
      async handleHttp(webletId, request) {
        return E(publicationFor(webletId).handler).handleHttp(request);
      },
      /**
       * @param {string} webletId
       * @param {UserDaemonRequest} request
       */
      async handleWebSocketUpgrade(webletId, request) {
        const publication = publicationFor(webletId);
        if (!publication.hasWebSocket) {
          throw makeError(
            X`Weblet ${q(webletId)} was published without WebSocket support`,
          );
        }
        return E(publication.handler).handleWebSocketUpgrade(request);
      },
      /** @param {string} root */
      async fetchContentTree(root) {
        for (const publication of publications.values()) {
          if (publication.contentTreeRoot === root) {
            return E(publication.handler).fetchContentTree(root);
          }
        }
        throw makeError(
          X`Content tree ${q(root)} is not published by this daemon`,
        );
      },
    }),
  );

  const addition = await proveKeyPossession({ bootstrap, crypto, signer });
  /** @type {Registration} */
  const registration = await E(bootstrap).register({
    ...addition,
    daemon,
    cancelled: cancelKit.promise,
  });

  const publisher = makeExo(
    'GatewayUserDaemonPublisher',
    UserDaemonPublisherInterface,
    /** @type {any} */ ({
      /** @param {UserDaemonPublication} publication */
      async publishWeblet(publication) {
        const { webletId, contentTreeRoot, hasWebSocket, handler } =
          publication;
        await E(registration).publishWeblet({
          webletId,
          contentTreeRoot,
          hasWebSocket,
        });
        // Record locally only after the gateway accepts, so a rejected
        // descriptor never becomes reachable through the callback exo.
        publications.set(
          webletId,
          harden({ webletId, contentTreeRoot, hasWebSocket, handler }),
        );
      },
      /** @param {string} webletId */
      async unpublishWeblet(webletId) {
        // Drop locally first so the gateway cannot reach a weblet the
        // daemon has already decided to withdraw.
        publications.delete(webletId);
        await E(registration).unpublishWeblet(webletId);
      },
      /** @param {KeySigner} additionalSigner */
      async addPublicKey(additionalSigner) {
        const proof = await proveKeyPossession({
          bootstrap,
          crypto,
          signer: additionalSigner,
        });
        await E(registration).addPublicKey(proof);
      },
      async listWeblets() {
        return harden(
          [...publications.values()].map(
            ({ webletId, contentTreeRoot, hasWebSocket }) => ({
              webletId,
              contentTreeRoot,
              hasWebSocket,
            }),
          ),
        );
      },
      async getRegistration() {
        return registration;
      },
      async deregister() {
        cancelKit.resolve(undefined);
        await E(registration).deregister();
      },
    }),
  );
  return /** @type {UserDaemonPublisher} */ (
    /** @type {unknown} */ (publisher)
  );
};
harden(registerUserDaemon);
