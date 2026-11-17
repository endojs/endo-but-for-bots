// @ts-check
import { Far } from '@endo/pass-style';
import { E } from '@endo/eventual-send';

/** @param {any} host */
export const make = host => {
  let markClosing = () => {};
  let release = () => {};
  const closing = new Promise(resolve => {
    markClosing = () => resolve(undefined);
  });
  const gate = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let constructions = 0;
  let draining = 0;
  return Far('DisposalBarrierControl', {
    constructed: () => {
      constructions += 1;
      return constructions;
    },
    closing: () => closing,
    drain: () => {
      draining += 1;
      markClosing();
      return gate;
    },
    draining: () => draining,
    probe: name => E(host).lookup(name),
    release: () => release(),
    count: () => constructions,
  });
};
harden(make);
