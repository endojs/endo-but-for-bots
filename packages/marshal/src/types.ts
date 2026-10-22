// spell-out-exempt: preserve longstanding public API names such as ConvertValToSlot and errorIdNum.
import type { ParcelObject, Passable, PassableCap } from '@endo/pass-style';

export type ConvertValToSlot<Slot, Value extends PassableCap = any> = (
  value: Value,
) => Slot;

export type ConvertSlotToVal<Slot, Value extends PassableCap = any> = (
  slot: Slot,
  iface?: string,
) => Value;

export type EncodingClass<T> = { '@qclass': T };

export type EncodingUnion =
  | EncodingClass<'NaN'>
  | EncodingClass<'undefined'>
  | EncodingClass<'Infinity'>
  | EncodingClass<'-Infinity'>
  | (EncodingClass<'bigint'> & { digits: string })
  | EncodingClass<'@@asyncIterator'>
  | (EncodingClass<'symbol'> & { name: string })
  | (EncodingClass<'error'> & {
      name: string;
      message: string;
      errorId?: string;
      cause?: Encoding;
      errors?: Encoding[];
    })
  | (EncodingClass<'slot'> & { index: number; iface?: string })
  | (EncodingClass<'parcel'> & { location: string })
  | (EncodingClass<'hilbert'> & { original: Encoding; rest?: Encoding })
  | (EncodingClass<'tagged'> & { tag: string; payload: Encoding })
  | (EncodingClass<'byteArray'> & { data: string });

export type EncodingElement = boolean | number | null | string | EncodingUnion;

export type TreeOf<T> = T | { [key: PropertyKey]: TreeOf<T> };

/**
 * The JSON-representable structure describing the complete shape and
 * pass-by-copy data of a Passable.
 */
export type Encoding = TreeOf<EncodingElement>;

export type CapData<Slot> = {
  /** A JSON.stringify of an Encoding. */
  body: string;
  slots: Slot[];
};

export type ToCapData<Slot> = (value: Passable) => CapData<Slot>;

/** A decoded root whose more specific type is not encoded in CapData. */
export type FromCapData<Slot> = (data: CapData<Slot>) => unknown;

export type Marshal<Slot> = {
  /** @deprecated Use toCapData. */
  serialize: ToCapData<Slot>;
  /** @deprecated Use fromCapData. */
  unserialize: FromCapData<Slot>;
  toCapData: ToCapData<Slot>;
  fromCapData: FromCapData<Slot>;
};

export type MakeMarshalOptions = {
  /** Controls whether serialized errors carry tagging information. */
  errorTagging?: 'on' | 'off';
  /** Used to identify sent errors. */
  marshalName?: string;
  /** Starting point for ascending identifiers relative to this marshal. */
  errorIdNum?: number;
  /** Records a sent error after its identifier has been attached. */
  marshalSaveError?: (error: Error, errorId?: string) => void;
  /** Observes a decoded error and its optional wire-level identifier. */
  marshalLoadError?: (error: Error, errorId?: string) => void;
  /** Privileged hook that obtains a Parcel's transport location. */
  encodeParcel?: (parcel: ParcelObject) => string;
  /** Binds an incoming location to this endpoint's Parcel open authority. */
  decodeParcel?: (location: string) => ParcelObject;
  /** Formatting for the body property of CapData. */
  serializeBodyFormat?: 'capdata' | 'smallcaps';
};

/** Inclusive lower and upper string-comparison bounds. */
export type RankCover = [string, string];

export type RankComparison = -1 | 0 | 1;

/** A total preorder over passable ranks. */
export type RankCompare = (left: any, right: any) => RankComparison;

/** A RankCompare refined into a total order over its inputs. */
export type FullCompare = RankCompare;

/** NaN represents values that are incomparable in the partial order. */
export type PartialComparison = RankComparison | number;

export type PartialCompare<T = any> = (left: T, right: T) => PartialComparison;
