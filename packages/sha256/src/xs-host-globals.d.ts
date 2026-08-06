/** Binary-safe SHA-256 host functions supplied by the Endor XS runtime. */
declare const hostSha256Init: () => number;
declare const hostSha256UpdateBytes: (
  handle: number,
  bytes: Uint8Array,
) => void;
declare const hostSha256Finish: (handle: number) => string;
