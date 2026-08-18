import type { FunctionComponent, VNode } from 'preact';

export interface CompositionRegion {
  /** The party OBJECT this region is attributed to (not a name or id). */
  party?: object;
  /** A `confineComponent` wrapper for the party's content. */
  Component: FunctionComponent<any>;
  /** The party's own input, passed to nobody else. */
  props?: object;
}

export interface ComposeOptions {
  /** Host resolver: party OBJECT → the reader's local name (or undefined). */
  nameOf?: (party: object) => string | undefined;
  /**
   * An optional pattern badge, minted ONCE by the caller via
   * `makePatternBadge`, placed in the frame header to authenticate the
   * composition itself.
   */
  FrameBadge?: FunctionComponent<any>;
  /** Optional frame label text. */
  label?: string;
}

/**
 * Build a multi-party composition tree — several parties' confined content in
 * one document, each region attributed by the frame. Render the result through
 * `renderConfined`. Sibling opacity is inherited from `confineComponent`; the
 * frame places every attribution and refuses non-confined region content.
 */
export function composeRegions(
  regions: CompositionRegion[],
  opts?: ComposeOptions,
): VNode;
