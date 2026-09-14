// @ts-check

/**
 * The OpenCode broker service kit: the shared provider broker service
 * (`@endo/hosted-agent/provider-broker-service.js`) over the OpenRouter policy
 * and account. See that module for the retention and close contract.
 * @module
 */
import { makeProviderBrokerServiceKit } from '@endo/hosted-agent/provider-broker-service.js';

import {
  OPENCODE_BROKER_ACCOUNT,
  buildOpencodeBrokerPolicy,
} from './opencode-broker.js';

/**
 * @param {Omit<Parameters<typeof makeProviderBrokerServiceKit>[0], 'label' | 'policy' | 'accountRef'> & { models: readonly string[] }} options
 */
export const makeOpencodeBrokerServiceKit = ({ models, ...options }) =>
  makeProviderBrokerServiceKit({
    ...options,
    label: 'OpenCode',
    policy: buildOpencodeBrokerPolicy({ models }),
    accountRef: OPENCODE_BROKER_ACCOUNT,
  });
harden(makeOpencodeBrokerServiceKit);
