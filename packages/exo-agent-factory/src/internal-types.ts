import type { EffectivePolicy } from './types.js';

/** The phases a child operation's journal records move it through. */
export type ChildPhase =
  | 'Intended'
  | 'GuestCreated'
  | 'Endowed'
  | 'DriverCreated'
  | 'Pinned'
  | 'Committed'
  | 'Removing'
  | 'Removed';

/** The coordinator's in-memory view of one child operation. */
export interface Operation {
  /** `<namespace>.<sequence>`, the durable operation id. */
  key: string;
  namespaceId: number;
  /** The user-visible child name. */
  name: string;
  phase: ChildPhase;
  instructions: string;
  endowmentNames: string[];
  createdAt: number;
  /** Set when a derived name held the wrong formula type; journaled. */
  fault?: string;
  /** An in-flight removal to join. */
  removal?: Promise<void>;
  watchers: Set<() => void>;
}

/** The coordinator's in-memory view of one factory namespace. */
export interface Namespace {
  id: number;
  parent: number | undefined;
  /** Its name in the parent's derived index. */
  name: string | undefined;
  policy: EffectivePolicy;
  /** Namespace whose `maker<n>` record holds this namespace's maker. */
  makerNamespaceId: number | undefined;
  phase: 'Active' | 'Revoking' | 'Revoked';
  nextSequence: number;
  children: Map<string, Operation>;
  derived: Map<string, number>;
  revocation?: Promise<void>;
}
