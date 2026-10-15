/**
 * The members of a validated pre-lockdown `globalThis.Parcel` that SES reads
 * once by descriptor and later delegates to.
 */
export type ParcelSample = {
  Parcel: new (location: unknown, openHook: unknown) => object;
  open: (parcel: unknown) => Promise<unknown>;
  isParcel: (value: unknown) => boolean;
  prototype: object;
};
