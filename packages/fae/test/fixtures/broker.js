// @ts-check
import { Far } from '@endo/far';
import { make as makeSubscription } from './subscription.js';

// The production subscription-module.js wraps this inert broker. All daemon
// setup/formula APIs remain real; only the external model service is replaced.
export const make = () => {
  const subscription = makeSubscription();
  return Far('WhylipTestBroker', {
    subscription: () => subscription,
    listModels: backend => {
      if (backend !== 'fae-codex') throw Error('Unexpected inference backend');
      return harden([{
        backendId: 'fae-codex', modelId: 'test-luna', reasoningEfforts: ['low'],
      }]);
    },
  });
};
harden(make);
