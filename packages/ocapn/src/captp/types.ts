export type SlotType = 'a' | 'p' | 'o';
/**
 * A slot is a branded string of the form (type)(+|-)(position),
 * where `+` means local (exported) and `-` means remote (imported).
 * The type parameter carries the slot-type letter so that callers which
 * build slots with a known literal (e.g. makeSlot('p', ...)) can recover
 * that information through parseSlot and table lookups.
 */
export type Slot<T extends SlotType = SlotType> =
  `${T}${'+' | '-'}${string}` & {
    _brand: 'captp-slot';
  };
