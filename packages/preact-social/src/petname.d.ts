import type { FunctionComponent } from 'preact';

export interface PetNameOptions {
  /**
   * If given, an unnamed chip becomes activatable so the reader can name the
   * party on the spot. Called with the party OBJECT (the guest chose which
   * object to pass, so validate it against the host's own known parties).
   */
  onName?: (party: object) => void;
  /** Forwarded to `confineComponent`: called if the chip's render throws. */
  onError?: (error: unknown) => void;
}

/**
 * Mint a sealed petname chip. `nameOf` resolves a party OBJECT to the reader's
 * local name (or undefined). The guest places `h(PetName, { party })` with a
 * party it was handed; it neither reads the name nor can forge the chip.
 * Confine once per address book, not per render.
 */
export function makePetName(
  nameOf: (party: object) => string | undefined,
  opts?: PetNameOptions,
): FunctionComponent<{ party?: object }>;
