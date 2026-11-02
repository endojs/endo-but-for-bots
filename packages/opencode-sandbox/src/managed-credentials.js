// @ts-check

/**
 * The OpenRouter credential the hosted setup mints in Secrets; see
 * `@endo/hosted-agent/managed-credentials.js`.
 * @module
 */
import { provideManagedCredentials as provideHostedManagedCredentials } from '@endo/hosted-agent/managed-credentials.js';

/**
 * @param {any} host
 * @param {{ name: string, apiKey?: string, kind: string }} spec
 */
export const provideManagedCredentials = (host, spec) =>
  provideHostedManagedCredentials(host, { ...spec, label: 'OpenRouter' });
harden(provideManagedCredentials);
