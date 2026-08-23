import type { ERef } from '@endo/eventual-send';

/** An opaque capability handle endowed into a code-mode compartment. */
export type PowerHandle = object;

/** A code-mode power passed inline or resolved from a lookup handle. */
export type CodeModePower = ERef<PowerHandle>;

/** The host capability used to resolve powers by pet name. */
export type LookupPowers = {
  lookup: (petName: string | string[]) => Promise<PowerHandle>;
};

/** Store a completion value under a pet name or pet-name path. */
export type StoreValue = (
  valueOrPromise: unknown,
  nameOrPath: string | string[],
) => Promise<void> | void;

/** A generated TypeScript declaration for a code-mode global. */
export interface GlobalDeclaration {
  /** The root type name following `declare const <name>:`. */
  body: string;
  /** Supporting type aliases emitted before the root declaration. */
  aux?: string;
}

/** A lexical global made available to code-mode source. */
export interface CodeModeGlobal {
  name: string;
  petName?: string | string[];
  description?: string;
  /** A generated declaration for the global, when one is available. */
  declaration?: GlobalDeclaration;
}

/**
 * A live code-mode capability together with the exact declaration derived for
 * the lexical binding that receives it.
 */
declare const codeModeGrantBrand: unique symbol;
export interface CodeModeGrant {
  /** Only a trusted code-mode grant minter can produce this brand. */
  readonly [codeModeGrantBrand]: 'CodeModeGrant';
  name: string;
  petName?: string | string[];
  description?: string;
  declaration: GlobalDeclaration;
  capability: CodeModePower;
}

/** The input accepted by a code-mode evaluator. */
export interface EvaluateInput {
  source: string;
  resultName?: string | string[];
  globals: CodeModeGlobal[];
}

/** Evaluate source in a code-mode compartment. */
export type Evaluate = (input: EvaluateInput) => Promise<unknown>;

/** An evaluator that may advertise named-result storage authority. */
export type EvaluateWithStoreValue = Evaluate & { hasStoreValue?: boolean };
