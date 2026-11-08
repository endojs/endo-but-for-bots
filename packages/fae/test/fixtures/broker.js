// @ts-check
import { Far } from '@endo/far';
import { make as makeSubscription } from './subscription.js';

// The production subscription-module.js wraps this inert broker. All daemon
// setup/formula APIs remain real; only the external model service is replaced.
export const make = () => {
  const subscription = makeSubscription();
  return Far('WhylipTestBroker', {
    subscription: () => subscription,
    modelCatalog: () => harden({accounts:[{subscriptionId:'primary',state:'current',observedAt:1,models:[{
      id:'test-luna',title:'Test',description:'',default:false,defaultReasoningEffort:'low',reasoningEfforts:['low'],
    }]}]}),
  });
};
harden(make);
