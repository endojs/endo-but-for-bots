// @ts-check
// Operator-to-daemon secret ingestion. The model can request a credential and
// receive only a capability handle; the bytes travel CapTP from the Floot UI
// to the factory and are minted as a daemon credential. They never enter a
// tool argument, a transcript, or exec source.

import { E } from '@endo/eventual-send';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   petName: string,
 *   kind: string,
 *   audience: string,
 *   username?: string,
 * }} SecretRequestInfo
 */

/**
 * @typedef {{
 *   petName: string,
 *   kind: string,
 *   audience: string,
 *   byteLength: number,
 * }} SecretReceipt
 */

/**
 * @typedef {(value: unknown, info: SecretRequestInfo) => Promise<SecretReceipt>} SecretAcceptor
 */

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
const requireSecretString = (value, fieldName) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new Error(`${fieldName} must not contain NUL bytes`);
  }
  return value;
};
harden(requireSecretString);

/**
 * @param {unknown} value
 * @returns {string}
 */
const requirePetName = value => {
  const name = requireSecretString(value, 'petName');
  if (name.includes('/') || name.startsWith('@')) {
    throw new Error('petName must be a single petname, not a path');
  }
  return name;
};
harden(requirePetName);

/**
 * A single-use bridge between a trusted secret-entry UI and a policy-specific
 * acceptor. The broker never interprets or retains submitted bytes itself.
 * Credential minting is one acceptor; a seed-once managed file (such as a
 * Codex auth store) can use the same UI without pretending to be a credential.
 *
 * @param {object} [options]
 * @param {() => string} [options.randomId]
 */
export const makeSecretRequestBroker = ({
  randomId = () =>
    `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) => {
  /** @type {{ info: SecretRequestInfo, accept: SecretAcceptor, settle: (receipt: SecretReceipt) => void, fail: (err: Error) => void } | undefined} */
  let pending;

  const getPending = () => (pending ? harden({ ...pending.info }) : null);

  /**
   * @param {Omit<SecretRequestInfo, 'id'>} details
   * @param {SecretAcceptor} accept
   * @returns {Promise<SecretReceipt>}
   */
  const request = (details, accept) => {
    if (pending) {
      throw new Error(
        `A secret request is already waiting (${pending.info.petName}). Wait for it or cancel it.`,
      );
    }
    const info = harden({ ...details, id: randomId() });
    return new Promise((resolve, reject) => {
      pending = { info, accept, settle: resolve, fail: reject };
    });
  };
  harden(request);

  /**
   * @param {string} requestId
   * @param {unknown} value
   */
  const submit = async (requestId, value) => {
    await null;
    if (!pending || pending.info.id !== requestId) {
      throw new Error('No matching secret request is waiting');
    }
    const requestState = pending;
    // Consume the request before invoking application code, making submission
    // single-use even if the acceptor is slow or rejects.
    pending = undefined;
    try {
      const receipt = await requestState.accept(value, requestState.info);
      requestState.settle(receipt);
      return receipt;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      requestState.fail(err);
      throw err;
    }
  };
  harden(submit);

  /** @param {string} requestId */
  const cancel = requestId => {
    if (!pending || pending.info.id !== requestId) return;
    const { fail } = pending;
    pending = undefined;
    fail(new Error('The operator cancelled the secret request'));
  };
  harden(cancel);

  return harden({ getPending, request, submit, cancel });
};
harden(makeSecretRequestBroker);

/**
 * Per-session kit: one pending request at a time, minted through the host.
 *
 * @param {object} options
 * @param {any} options.host - factory host powers (`provideBearerCredential`)
 * @param {any} options.sessionGuest - session guest that will hold the cap
 * @param {string} options.sessionId
 * @param {Record<string, SecretAcceptor>} [options.managedAcceptors]
 * @param {() => string} [options.randomId]
 * @returns {{
 *   tools: Record<string, any>,
 *   getPending: () => SecretRequestInfo | null,
 *   request: (details: Omit<SecretRequestInfo, 'id'>, accept: SecretAcceptor) => Promise<SecretReceipt>,
 *   submit: (requestId: string, value: unknown) => Promise<SecretReceipt>,
 *   cancel: (requestId: string) => void,
 * }}
 */
export const makeSecretRequestKit = ({
  host,
  sessionGuest,
  sessionId,
  managedAcceptors = {},
  randomId = () =>
    `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
}) => {
  const broker = makeSecretRequestBroker({ randomId });

  /**
   * @param {SecretRequestInfo} info
   * @param {unknown} value
   * @returns {Promise<SecretReceipt>}
   */
  const acceptCredential = async (info, value) => {
    await null;
    // Stable per (session, petName), NOT per request. Keying on the request
    // id minted a fresh permanent host name every time, and the material of
    // an ingested credential dies with the daemon process — so the ordinary
    // path, re-requesting the same secret after a restart, left the dead one
    // bound forever. Rebind the one name instead.
    const hostName = `floot-secret-${sessionId}-${info.petName}`;
    if (await E(host).has(hostName)) {
      await E(host).remove(hostName);
    }
    /** @type {unknown} */
    let cap;
    let byteLength = 0;
    if (info.kind === 'basic') {
      const record =
        value && typeof value === 'object'
          ? /** @type {Record<string, unknown>} */ (value)
          : { password: value };
      const password = requireSecretString(record.password, 'password');
      const username = requireSecretString(
        record.username || info.username || 'user',
        'username',
      );
      byteLength = new TextEncoder().encode(password).byteLength;
      cap = await E(host).provideBasicCredential(hostName, {
        audience: info.audience,
        username,
        password,
      });
    } else {
      const token = requireSecretString(value, 'secret');
      byteLength = new TextEncoder().encode(token).byteLength;
      cap = await E(host).provideBearerCredential(hostName, {
        audience: info.audience,
        token,
      });
    }
    if (await E(sessionGuest).has(info.petName)) {
      await E(sessionGuest).remove(info.petName);
    }
    await E(sessionGuest).storeValue(cap, info.petName);
    /** @type {SecretReceipt} */
    const receipt = harden({
      petName: info.petName,
      kind: info.kind,
      audience: info.audience,
      byteLength,
    });
    return receipt;
  };
  harden(acceptCredential);

  const requestSecretTool = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'requestSecret',
          description:
            'Ask the operator to submit a secret (API token, private key, ' +
            'service-account JSON) through a paste box in the UI. You receive ' +
            'only a capability handle stored under petName — never the bytes. ' +
            'NEVER ask the user to paste secrets into chat or put them in exec. ' +
            'Pass the resulting handle to provideGitRemote / provideGitClone as ' +
            '`credential`, or write it to a mount with writeSecret. ' +
            'The material is held in the daemon process, so it does NOT survive ' +
            'a daemon restart: the handle keeps its name but stops working, ' +
            'which GitRemote.credentialHealth() reports as revoked. Ask for it ' +
            'again rather than assuming a stored petname is still usable.',
          parameters: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description:
                  'What the operator is being asked for, shown in the paste box.',
              },
              petName: {
                type: 'string',
                description:
                  'Petname in THIS session store for the resulting capability.',
              },
              kind: {
                type: 'string',
                description:
                  '"bearer" (default) for a token or opaque blob; "basic" for username+password; "codexAuth" to seed the host Codex login once.',
              },
              audience: {
                type: 'string',
                description:
                  'Origin this credential may be used for (e.g. https://git.example). Defaults to the label.',
              },
              username: {
                type: 'string',
                description: 'Optional username hint when kind is basic.',
              },
            },
            required: ['label', 'petName'],
          },
        },
      }),
    /**
     * @param {Record<string, unknown>} args
     */
    execute: async args => {
      const label = requireSecretString(args.label, 'label');
      const petName = requirePetName(args.petName);
      const requestedKind =
        typeof args.kind === 'string' && args.kind ? args.kind : 'bearer';
      const kind =
        requestedKind === 'basic' || requestedKind === 'bearer'
          ? requestedKind
          : requestedKind in managedAcceptors
            ? requestedKind
            : (() => {
                throw new Error(`Unsupported secret kind: ${requestedKind}`);
              })();
      const audience =
        typeof args.audience === 'string' && args.audience
          ? requireSecretString(args.audience, 'audience')
          : label;
      const username =
        typeof args.username === 'string' && args.username
          ? requireSecretString(args.username, 'username')
          : undefined;
      /** @type {Omit<SecretRequestInfo, 'id'>} */
      const details = harden({
        label,
        petName,
        kind,
        audience,
        ...(username === undefined ? {} : { username }),
      });
      const receipt = await broker.request(details, (value, info) => {
        const managed = managedAcceptors[info.kind];
        return managed ? managed(value, info) : acceptCredential(info, value);
      });
      return JSON.stringify(receipt);
    },
    help: () =>
      'Request a secret from the operator via a UI paste box. Returns a capability handle, never the bytes.',
  });

  const writeSecretTool = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'writeSecret',
          description:
            'Write a secret capability (from requestSecret) onto a mount or ' +
            'git workspace you hold, without revealing the bytes. Use this ' +
            'when a program needs the secret as a file.',
          parameters: {
            type: 'object',
            properties: {
              petName: {
                type: 'string',
                description:
                  'Petname of the secret capability in this session.',
              },
              destPetName: {
                type: 'string',
                description:
                  'Petname of a writable mount, or a git workspace whose worktree will be used.',
              },
              path: {
                type: 'string',
                description: 'Relative file path to write on that mount.',
              },
            },
            required: ['petName', 'destPetName', 'path'],
          },
        },
      }),
    /**
     * @param {Record<string, unknown>} args
     */
    execute: async args => {
      const petName = requirePetName(args.petName);
      const destPetName = requirePetName(args.destPetName);
      const filePath = requireSecretString(args.path, 'path');
      if (filePath.includes('\0') || filePath.startsWith('/')) {
        throw new Error('path must be a relative file path');
      }
      const cap = await E(sessionGuest).lookup(petName);
      let dest = await E(sessionGuest).lookup(destPetName);
      // eslint-disable-next-line no-underscore-dangle
      const methods = await E(dest).__getMethodNames__();
      if (Array.isArray(methods) && methods.includes('worktree')) {
        dest = await E(dest).worktree();
      }
      await E(host).writeSecret(dest, filePath, cap);
      return JSON.stringify({ written: filePath, destPetName, petName });
    },
    help: () =>
      'Write a secret capability to a mount path without revealing the bytes.',
  });

  return harden({
    tools: {
      requestSecret: requestSecretTool,
      writeSecret: writeSecretTool,
    },
    getPending: broker.getPending,
    request: broker.request,
    submit: broker.submit,
    cancel: broker.cancel,
  });
};
harden(makeSecretRequestKit);
