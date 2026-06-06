import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const ExoServiceI = M.interface('ExoService', {
  ping: M.call().returns(M.string()),
});

export const make = () =>
  makeExo('ExoService', ExoServiceI, {
    ping() {
      return 'pong';
    },
  });
