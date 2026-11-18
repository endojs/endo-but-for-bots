// @ts-check
/**
 * The `SecretWriter` (M2 W2.3; D-6; `designs/m2-interfaces.md` 3.4, 9.2):
 * the only object that takes a secret value, and it lives in the agent-host
 * adapter, never in a vat.
 *
 * Two write paths, one store write:
 *
 * - `writer`, the remotable `SecretWriter` (`SecretsAdmin.openWriter()`,
 *   reachable through the hub): it takes a `SealedBox` only (a box
 *   sealed to `publicKey()`, X25519 + AES-256-GCM, `seal.js`), so a value
 *   never travels through the hub, its log or its image in clear. A plain
 *   string from any caller is refused before anything is read or written,
 *   with a fixed text that does not repeat it (X-FIX).
 * - `replaceLocal(secret, value | SealedBox, expectedGeneration?)`, a plain
 *   function of this process that no remotable exposes: the gateway's
 *   in-process writer (`GW/index.js`, `GatewayContext.secretWriter()`)
 *   calls it with the value a page typed, which reached the adapter over
 *   the page's WebSocket and never crosses the hub (m3-interfaces A-11).
 *
 * Both find a `Secret`'s store key by amplification: the manager vat's sink
 * maps the presence it is given (`resolveSecrets`), so the caller proves it
 * holds the Secret by passing it, and no id or name is ever exchanged.
 * A writer belongs to one adapter incarnation: after a restart it is a
 * tombstone and the caller opens a new one (`SecretsAdmin.openWriter`).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { count, R, record, text } from '../../../../guest/lib/guards/base.js';
import { shapes } from '../../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { secretError } from './store.js';

const { M, makeExo, matches } = /** @type {any} */ (globalThis);

/*
 * The value argument (X-FIX): a guard that refuses a value quotes it in its
 * pattern error, so the writers' exo guards take any passable there and the
 * method checks the shape with `matches`, refusing with a fixed text that
 * never names the value (`secretFailed("INVALID_SECRET_BYTES")`, one
 * of the fixed `secretCodes`: the store's own code for a value it cannot
 * take). What is accepted
 * is unchanged: `interfaces.SecretWriter` (a `SealedBox`) for the hub's
 * writer, a plain value or a box for the gateway's.
 */

/** @type {any} */
let localGuard;
/**
 * The guard of the gateway's in-process writer (`GW/index.js`): the same
 * arguments as the M2 contract's browser path (a plain value up to
 * `limits.secretValueBytes`, or a `SealedBox`: `assertLocalValue`), on an
 * object that is gateway-local and never exported to the hub. Built on
 * first use.
 */
export const localWriterGuard = () => {
  localGuard ??= M.interface('GatewaySecretWriter', {
    replace: M.callWhen(M.remotable('Secret'), M.any())
      .optional(count)
      .returns(record({ generation: count })),
    publicKey: M.callWhen().returns(text(64)),
  });
  return localGuard;
};

/** @type {any} */
let hubGuard;
/**
 * The hub writer's exo guard: `interfaces.SecretWriter` with the value
 * argument checked in the method (`SealedBox` only) instead.
 */
const hubWriterGuard = () => {
  hubGuard ??= M.interface('SecretWriter', {
    replace: M.callWhen(R('Secret'), M.any())
      .optional(count)
      .returns(record({ generation: count })),
    publicKey: M.call().returns(text(64)),
  });
  return hubGuard;
};

/**
 * @param {unknown} value
 * @param {any} shape
 */
const assertValueShape = (value, shape) => {
  if (!matches(value, shape)) throw secretError('INVALID_SECRET_BYTES');
};

/**
 * The gateway writer's value check (a plain value up to
 * `limits.secretValueBytes`, or a `SealedBox`); the refusal never names it.
 * @param {unknown} value
 */
export const assertLocalValue = value =>
  assertValueShape(value, M.or(shapes.SecretValue, shapes.SealedBox));
harden(assertLocalValue);

/**
 * @typedef {{ format: string, publicKey: string, box: string }} SealedBox
 */

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {{ publicKey: () => string, open: (box: any) => string }} options.seal
 *   ready sealing keys
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret
 */
export const makeSecretWriter = ({ store, seal, resolveSecret }) => {
  /**
   * @param {any} secret
   * @param {string} plain
   * @param {number} [expectedGeneration]
   */
  const write = async (secret, plain, expectedGeneration) => {
    const key = await resolveSecret(secret);
    if (key === null) throw secretError('UNKNOWN_SECRET');
    const generation = await store.replace(key, plain, expectedGeneration);
    return harden({ generation });
  };

  const writer = makeExo('SecretWriter', hubWriterGuard(), {
    /**
     * @param {any} secret
     * @param {SealedBox} box only a box: a plain value is refused with a
     *   fixed text before anything is read or written
     * @param {number} [expectedGeneration]
     */
    replace: async (secret, box, expectedGeneration) => {
      assertValueShape(box, shapes.SealedBox);
      return write(secret, seal.open(box), expectedGeneration);
    },
    publicKey: () => seal.publicKey(),
  });

  /**
   * The in-process path (not a method of any remotable). The caller's own
   * guard has checked the arguments' shapes (`GW/index.js`); the store
   * checks the value's type and size again.
   * @param {any} secret
   * @param {string | SealedBox} value
   * @param {number} [expectedGeneration]
   */
  const replaceLocal = (secret, value, expectedGeneration) =>
    write(
      secret,
      typeof value === 'string' ? value : seal.open(value),
      expectedGeneration,
    );

  return harden({ writer, replaceLocal });
};
harden(makeSecretWriter);
