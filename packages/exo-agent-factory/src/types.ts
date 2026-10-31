/**
 * Policy data chosen by a factory's authority holder, as a `bind` or
 * `attenuate` argument. Every field is optional; an absent field inherits the
 * issuing facet's value.
 */
export interface ChildAgentPolicy {
  /**
   * Children this namespace and every namespace derived from it may retain
   * at once.
   */
  maxChildren?: number;
  /** UTF-8 size bound on `create`'s `instructions`. */
  maxInstructionBytes?: number;
  /** The endowment names `create` admits. */
  endowmentNames?: readonly string[];
}

/**
 * The policy a deployment installs at the root. Every field is required: the
 * root bounds everything below it, so it cannot inherit.
 */
export interface RootPolicy {
  maxChildren: number;
  maxInstructionBytes: number;
  endowmentNames: readonly string[];
}

/** A policy with every field present, as held by a namespace. */
export interface EffectivePolicy {
  maxChildren: number;
  maxInstructionBytes: number;
  /** Sorted, without duplicates. */
  endowmentNames: string[];
}

/**
 * The coordinator's powers, seen through the daemon directory vocabulary. In
 * a deployment this is the dedicated `agent-factory` child host, so every
 * name below is in the coordinator's private namespace. Only the coordinator
 * writes it; no facet, child, or driver receives it.
 */
export interface PrivateHost {
  has(...path: string[]): Promise<boolean>;
  /**
   * Looking up a formula incarnates it, which is how the coordinator starts
   * a runner.
   */
  lookup(...path: string[]): Promise<any>;
  list(...path: string[]): Promise<string[]>;
  identify(...path: string[]): Promise<string | undefined>;
  formulaType(...path: string[]): Promise<string | undefined>;
  /** The identifier of the powers an unconfined caplet was formulated with. */
  powersOf(...path: string[]): Promise<string | undefined>;
  storeValue(value: any, path: string | string[]): Promise<void>;
  remove(...path: string[]): Promise<void>;
  cancel(...path: string[]): Promise<void>;
  provideGuest(name: string): Promise<any>;
}
