// @ts-check

import { E } from '@endo/eventual-send';
import {
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '../src/provider-broker-service.js';

const digest = `sha256:${'a'.repeat(64)}`;
const construct = makeOwnedProviderBrokerService({
  label: 'Catalog lifecycle fixture',
  readConfig: () => ({
    ownerId: 'catalog-formula-lifecycle',
    directory: '/tmp/catalog-fixture-never-opened',
    imageRef: `localhost/fixture@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/fixture@${digest}`,
  }),
  makePolicy: () => ({ policy: {}, accountAuthority: 'fixture' }),
  makeCredential: (_config, control) => {
    void E(control).note('construct');
    return harden({ current: () => E(control).renew() });
  },
  makeModelRead:
    ({ credential }) =>
    async () => {
      await credential.current();
      return harden({ observedAt: 1, models: [] });
    },
  makeServiceKit: options => {
    const kit = makeProviderBrokerServiceKit({
      ...options,
      runtimeKit: {
        open: async () => {
          throw Error('Metadata must not start runtime');
        },
        close: async () => {},
      },
    });
    return harden({
      service: kit.service,
      close: async () => {
        await E(options.secret).note('close-start');
        await kit.close();
        await E(options.secret).note('close-ack');
      },
    });
  },
});

/** @type {typeof construct} */
export const make = construct;
harden(make);
