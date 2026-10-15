/**
 * The members of a validated pre-lockdown `globalThis.Parcel` that SES reads
 * once by descriptor and later delegates to.
 */
export type ParcelSample = {
  /** The compatible initial constructor `lockdown` found on the global. */
  Parcel: any;
  open: (parcel: unknown) => unknown;
  isParcel: (value: unknown) => unknown;
  prototype: object;
};
