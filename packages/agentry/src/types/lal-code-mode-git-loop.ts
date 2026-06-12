import type { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';
import type {
  LalCodeModeExecute,
  LalCodeModeGlobal,
} from './lal-code-mode.js';

export declare const filesystemCapabilityType: string;

export type LalCodeModeGitLoopGlobalOptions = {
  workspaceName?: string;
  workspacePetName?: string | string[];
  gitName?: string;
  gitPetName?: string | string[];
  readOnlyGit?: boolean;
};

export declare function makeLalCodeModeGitLoopGlobals(
  options?: LalCodeModeGitLoopGlobalOptions,
): LalCodeModeGlobal[];

export declare function makeLalCodeModeGitLoopSystemPrompt(
  globals?: LalCodeModeGlobal[],
  options?: { preamble?: string },
): string;

export declare function makeLalCodeModeCompartmentExecute(options: {
  endowments: Record<string, unknown>;
  storeResult?: (
    value: unknown,
    resultName: string | string[],
  ) => Promise<void> | void;
}): LalCodeModeExecute;

export declare function makeLalCodeModeGitLoopAgent(options: {
  model: Model<string>;
  workspace: unknown;
  git: unknown;
  execute?: LalCodeModeExecute;
  endowments?: Record<string, unknown>;
  globals?: LalCodeModeGlobal[];
  systemPrompt?: string;
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readOnlyGit?: boolean;
}): Agent;
