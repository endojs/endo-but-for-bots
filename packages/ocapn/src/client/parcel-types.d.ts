import type { ParcelObject } from '@endo/pass-style';

import type { OcapnLocation } from '../codecs/components.js';
import type { ParcelTracker } from './parcels.js';
import type { Client as SturdyRefClient, OcapnBootstrap } from './types.js';

export type * from './types.js';

type ParcelClientDebug<Bootstrap> = Omit<
  NonNullable<SturdyRefClient<Bootstrap>['_debug']>,
  'sturdyRefTracker'
> & {
  parcelTracker: ParcelTracker;
};

export type Client<Bootstrap = OcapnBootstrap> = Omit<
  SturdyRefClient<Bootstrap>,
  '_debug'
> & {
  makeParcel: (
    location: OcapnLocation,
    secret: string | Uint8Array,
  ) => ParcelObject;
  openParcel: (parcel: ParcelObject) => Promise<any>;
  _debug?: ParcelClientDebug<Bootstrap>;
};
