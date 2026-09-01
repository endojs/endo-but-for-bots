export interface SturdyRefEscrow {
  render(value: unknown): unknown;
  redeem(value: unknown): unknown;
  clear(): void;
}

export declare function makeSturdyRefEscrow(options?: {
  randomBytes?: (bytes: Uint8Array) => Uint8Array;
}): SturdyRefEscrow;
