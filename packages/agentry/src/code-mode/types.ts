import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

import type {
  CodeModeGlobal,
  CodeModePower,
  Evaluate,
  LookupPowers,
  StoreValue,
} from '@endo/agent-tools/code-mode/types.js';

import type {
  Credentials,
  GetApiKey,
  ThinkingLevel,
} from '../harness/types.js';

/** The powers selected for a code-mode agent's lexical scope. */
export interface CodeModePowers {
  workspace?: CodeModePower;
  workspacePetName?: string;
  /**
   * Declaration surface for `workspace`.
   * Defaults to the daemon mount surface used by production provisioning.
   * Select `filesystem` only when `workspace` is an extended Filesystem.
   */
  workspaceSurface?: 'mount' | 'filesystem';
  git?: CodeModePower;
  gitPetName?: string;
  gitMode?: 'readOnly' | 'readWrite' | 'historyRewrite';
  /** Named capabilities are described as `unknown` until introspected. */
  namedPowers?: Array<Pick<CodeModeGlobal, 'name' | 'petName'>>;
}

/** Inputs for constructing a code-mode agent. */
export interface MakeCodeModeAgentOptions {
  model: Model<string>;
  powers?: CodeModePowers;
  /** Resolve capabilities not passed inline. */
  lookupPowers?: LookupPowers;
  credentials?: Credentials;
  endowments?: Record<string, unknown>;
  evaluate?: Evaluate;
  storeValue?: StoreValue;
  onContainedEventualSendRejection?: () => Promise<void> | void;
  globals?: CodeModeGlobal[];
  preamble?: string;
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  getApiKey?: GetApiKey;
  thinkingLevel?: ThinkingLevel;
}

/** Inputs for the repository-oriented code-mode loop preset. */
export interface GitLoopOptions {
  model: Model<string>;
  workspace: CodeModePower;
  git: CodeModePower;
  evaluate?: Evaluate;
  endowments?: Record<string, unknown>;
  onContainedEventualSendRejection?: () => Promise<void> | void;
  globals?: CodeModeGlobal[];
  systemPrompt?: string;
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  getApiKey?: GetApiKey;
  thinkingLevel?: ThinkingLevel;
  readOnlyGit?: boolean;
  storeValue?: StoreValue;
}
