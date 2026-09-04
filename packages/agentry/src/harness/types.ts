import type { Model } from '@earendil-works/pi-ai';

/** A capability-scoped view over named credentials. */
export interface Credentials {
  /** Resolve a named secret, or `undefined` when it is unset or empty. */
  get: (name: string) => string | undefined;
}

/** Resolve an API key for a provider through a credentials seam. */
export type GetApiKey = (
  provider: string,
) => Promise<string | undefined> | string | undefined;

/** Per-token costs reported by a model. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Budget overrides for a locally constructed model. */
export interface ModelBudget {
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
}

/** Configuration for resolving a model profile. */
export interface ModelProfileConfig extends ModelBudget {
  provider?: string;
  model?: string;
  baseUrl?: string;
  api?: 'openai-completions' | string;
  reasoning?: boolean;
}

/** Reasoning effort requested from a thinking-capable model. */
export type ThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** A named provider/model profile and its credential binding. */
export interface ModelProfileDefinition extends ModelBudget {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
  reasoning?: boolean;
  credential?: string | ((credentials: Credentials) => string | undefined);
}

/** A resolved model profile that can be bound to a credential seam. */
export interface ResolvedModelProfile {
  model: Model<string>;
  resolveCredential: (credentials: Credentials) => string | undefined;
}
