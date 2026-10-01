// @ts-check
import { Fail } from '@endo/errors';

/**
 * Usage observations must arrive before chatStream settles so the turn journal
 * can commit them with the corresponding result.
 * @typedef {object} StreamingProvider
 * @property {(messages: any[], tools: any[], onDelta: (delta: string) => void,
 * signal?: AbortSignal,
 * onUsage?: (usage: Partial<import('@endo/hosted-agent/token-usage.js').TokenUsage>) => void)
 * => Promise<any>} chatStream
 */

/**
 * Runtime selection is incarnation-local, never a persisted credential owner.
 * Provider lookup runs per turn; hosted construction runs after tool admission.
 * @typedef {{ kind: 'provider', provideProvider: () => StreamingProvider | Promise<StreamingProvider>, providerFormat?: string, disposeProvider?: () => Promise<void> } |
 * { kind: 'hosted', provideHostedClient: (snapshot: any) => any } |
 * { kind: 'records-only' }} RuntimeConfig
 */

/**
 * Refuse ambiguous and legacy configs before acquiring any session resources.
 * @param {RuntimeConfig} config
 */
export const assertRuntimeConfig = config => {
  (config && typeof config === 'object' && !Array.isArray(config)) ||
    Fail`Invalid Floot runtime configuration`;
  const { kind } = config;
  Object.hasOwn(config, 'kind') ||
    Fail`Floot runtime configuration requires an own kind`;
  kind === 'provider' ||
    kind === 'hosted' ||
    kind === 'records-only' ||
    Fail`Floot runtime configuration requires an explicit kind`;
  const field =
    kind === 'provider'
      ? 'provideProvider'
      : kind === 'hosted'
        ? 'provideHostedClient'
        : undefined;
  Reflect.ownKeys(config).every(
    key =>
      key === 'kind' ||
      key === field ||
      (kind === 'provider' &&
        ['providerFormat', 'disposeProvider'].includes(String(key))),
  ) || Fail`Unexpected Floot runtime configuration field`;
  if (kind === 'provider') {
    config.providerFormat === undefined ||
      config.providerFormat === 'responses-output-v1' ||
      Fail`Unknown direct provider context format`;
    config.disposeProvider === undefined ||
      typeof config.disposeProvider === 'function' ||
      Fail`Invalid provider disposal`;
  }
  if (field !== undefined) {
    (Object.hasOwn(config, field) && typeof config[field] === 'function') ||
      Fail`Floot runtime configuration requires its backend constructor`;
  }
};
harden(assertRuntimeConfig);
