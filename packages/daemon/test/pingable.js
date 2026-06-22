// A minimal powers-like caplet for the by-reference `powers` tests: it
// exposes a single `ping()` so a downstream caplet (see `powers-ping.js`)
// can prove it was instantiated with *this* capability.

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

export const make = () =>
  makeExo(
    'Pingable',
    M.interface('Pingable', {}, { defaultGuards: 'passable' }),
    {
      ping: () => 'pong-42',
    },
  );
