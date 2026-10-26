// @ts-check

import { makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// Resolve the trusted driver from this checkout. A caller cannot substitute an
// arbitrary unconfined module or ask the driver to run with host powers.
const DRIVER_URL = new URL('../../fae/driver.js', import.meta.url).href;
const BASE_NAME = /^whylip-[A-Za-z0-9_-]+$/;
const PROFILE_PREFIX = 'profile-for-';
const DRIVER_SUFFIX = '-driver';
const DRIVER_HANDLE_SUFFIX = '-driver-handle';

/** @param {string} name */
const isBase = name => name.length <= 256 && BASE_NAME.test(name);
/** @param {string} name */
const isProfile = name =>
  name.startsWith(PROFILE_PREFIX) && isBase(name.slice(PROFILE_PREFIX.length));
/** @param {string} name */
const isDriver = name =>
  name.endsWith(DRIVER_SUFFIX) && isBase(name.slice(0, -DRIVER_SUFFIX.length));
/**
 * @param {Record<string, unknown>} record
 * @param {string[]} expected
 */
const hasOnlyKeys = (record, expected) => {
  const keys = Object.keys(record);
  return (
    keys.length === expected.length && keys.every(key => expected.includes(key))
  );
};

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isBoundedPrompt = value =>
  typeof value === 'string' && value.length <= 64 * 1024;

const FactoryHostInterface = M.interface('WhylipFactoryHost', {
  has: M.call(M.string()).optional(M.string()).returns(M.promise()),
  list: M.call().returns(M.promise()),
  cancel: M.call(M.string()).returns(M.promise()),
  remove: M.call(M.string()).optional(M.string()).returns(M.promise()),
  lookup: M.call(M.string()).returns(M.promise()),
  locate: M.call(M.string()).returns(M.promise()),
  provideGuest: M.call(M.string(), M.record()).returns(M.promise()),
  makeUnconfined: M.call(M.string(), M.string(), M.record()).returns(
    M.promise(),
  ),
  copy: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
    M.promise(),
  ),
  help: M.call().returns(M.string()),
});

/**
 * Attenuate a dedicated, otherwise empty host for the Fae factory. The factory
 * can create only Whylip guests and run this checkout's fixed Fae driver with
 * one such guest's powers. It never receives the host or special-name access.
 *
 * @param {any} host
 */
export const makeFactoryHostAdapter = host =>
  makeExo('WhylipFactoryHost', FactoryHostInterface, {
    async has(name, child) {
      if (child !== undefined) {
        if (name !== '@pins' || !isDriver(child))
          throw makeError(X`Only matching Whylip driver pins can be inspected`);
        return E(host).has('@pins', child);
      }
      if (!isProfile(name) && !isBase(name))
        throw makeError(X`Only Whylip provisioning names can be inspected`);
      return E(host).has(name);
    },
    async list() {
      const names = await E(host).list();
      return harden(
        names.filter(name => typeof name === 'string' && isBase(name)),
      );
    },
    async cancel(name) {
      if (!isProfile(name))
        throw makeError(X`Only Whylip guest profiles can be cancelled`);
      return E(host).cancel(name);
    },
    async remove(name, child) {
      if (child !== undefined) {
        if (name !== '@pins' || !isDriver(child))
          throw makeError(X`Only matching Whylip driver pins can be removed`);
        return E(host).remove('@pins', child);
      }
      if (!isProfile(name) && !isBase(name))
        throw makeError(X`Only Whylip provisioning names can be removed`);
      return E(host).remove(name);
    },
    async lookup(name) {
      if (!isProfile(name))
        throw makeError(X`Only Whylip guest profiles can be looked up`);
      return E(host).lookup(name);
    },
    async locate(name) {
      if (!isProfile(name) && !isBase(name))
        throw makeError(X`Only Whylip guests and profiles can be located`);
      return E(host).locate(name);
    },
    async provideGuest(name, options) {
      if (
        !isBase(name) ||
        !hasOnlyKeys(options, ['agentName']) ||
        options.agentName !== `${PROFILE_PREFIX}${name}`
      )
        throw makeError(
          X`Whylip guests require their matching profile name and no introductions`,
        );
      return E(host).provideGuest(
        name,
        harden({ agentName: `${PROFILE_PREFIX}${name}` }),
      );
    },
    async makeUnconfined(worker, specifier, options) {
      const resultName = options.resultName;
      const env = options.env;
      if (
        worker !== '@main' ||
        specifier !== DRIVER_URL ||
        !hasOnlyKeys(options, ['powersName', 'resultName', 'env']) ||
        typeof resultName !== 'string' ||
        !isDriver(resultName)
      )
        throw makeError(X`Only the fixed Whylip Fae driver may be launched`);
      const base = resultName.slice(0, -DRIVER_SUFFIX.length);
      const profile = `${PROFILE_PREFIX}${base}${DRIVER_HANDLE_SUFFIX}`;
      if (
        options.powersName !== profile ||
        !env ||
        typeof env !== 'object' ||
        Array.isArray(env) ||
        !hasOnlyKeys(env, ['FAE_SYSTEM_PROMPT', 'FAE_SUBAGENT_PROMPT']) ||
        !isBoundedPrompt(env.FAE_SYSTEM_PROMPT) ||
        env.FAE_SUBAGENT_PROMPT !== ''
      )
        throw makeError(
          X`The Fae driver requires its matching guest profile and a bounded system prompt`,
        );
      return E(host).makeUnconfined(
        '@main',
        DRIVER_URL,
        harden({
          powersName: profile,
          resultName,
          env: {
            FAE_SYSTEM_PROMPT: env.FAE_SYSTEM_PROMPT,
            FAE_SUBAGENT_PROMPT: '',
          },
        }),
      );
    },
    async copy(from, to) {
      if (
        from.length !== 1 ||
        to.length !== 2 ||
        !isDriver(from[0]) ||
        to[0] !== '@pins' ||
        to[1] !== from[0]
      )
        throw makeError(
          X`Only a Whylip driver may be pinned under its own name`,
        );
      return E(host).copy(harden([from[0]]), harden(['@pins', from[0]]));
    },
    help() {
      return 'Scoped Whylip factory host. Provides matching whylip-* guest profiles; launches only the fixed Fae driver with its corresponding guest powers; pins only that driver; rolls back only Whylip provisioning names and matching pins. No host, filesystem, general special-name, arbitrary-module, or introduced-capability access.';
    },
  });
harden(makeFactoryHostAdapter);

/**
 * Provision with powersName '@agent' only in a fresh dedicated host namespace;
 * introduce this caplet's locator as the factory guest's 'host-agent'.
 * @param {any} powers
 */
export const make = powers => makeFactoryHostAdapter(powers);
harden(make);
