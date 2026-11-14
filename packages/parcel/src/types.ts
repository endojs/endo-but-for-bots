declare const parcelTypeBrand: unique symbol;

export type Parcel = {
  readonly [parcelTypeBrand]: true;
};

export type ParcelOpenHook = (location: string, parcel: Parcel) => unknown;
