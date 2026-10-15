declare const parcelTypeBrand: unique symbol;

export type Parcel = {
  readonly [parcelTypeBrand]: true;
  readonly [Symbol.toStringTag]: 'Parcel';
};

export type ParcelOpenHook = (location: string, parcel: Parcel) => unknown;
