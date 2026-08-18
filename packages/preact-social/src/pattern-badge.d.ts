import type { FunctionComponent } from 'preact';

export interface Pattern {
  glyph: string;
  words: [string, string];
  hue: number;
  hue2: number;
  phrase: string;
}

export interface PatternBadgeOptions {
  /** Default text shown when the guest supplies none. */
  label?: string;
  /** Forwarded to `confineComponent`: called if the badge's render throws. */
  onError?: (error: unknown) => void;
}

export interface PatternSecretStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Derive the user's visible pattern from their secret. Pure and stable. */
export function derivePattern(secret: string): Pattern;

/**
 * Get (or create) the user's pattern secret from a storage-like object. Fails
 * to a per-session secret on storage denial, never to "no pattern". Hand the
 * result ONLY to `makePatternBadge`.
 */
export function getOrCreatePatternSecret(
  storage: PatternSecretStorage,
  randomHex: () => string,
  key?: string,
): string;

/**
 * Mint the sealed trust badge carrying the user's pattern. The secret is
 * captured in the closure, never readable by the guest. The guest may pass
 * `text` (rendered beside the pattern, never inside it).
 */
export function makePatternBadge(
  secret: string,
  opts?: PatternBadgeOptions,
): FunctionComponent<{ text?: string }>;
