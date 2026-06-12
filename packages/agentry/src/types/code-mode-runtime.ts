import type {
  Agent,
  AgentMessage,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';
import type { ToolRecord } from '@endo/agent-tools';
import type {
  LalCodeModeExecute,
  LalCodeModeGlobal,
} from './lal-code-mode.js';

export type CodeModeModelConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  api?: 'openai-completions' | string;
  reasoning?: boolean;
  apiTokenPetName?: string | string[];
  apiTokenEnvVar?: string;
};

export type CodeModePowerConfig = {
  workspace?: unknown;
  workspacePetName?: string;
  git?: unknown;
  gitPetName?: string;
  gitMode?: 'readOnly' | 'readWrite';
  namedPowers?: LalCodeModeGlobal[];
};

export type CodeModeToolConfig = {
  mode?: 'executeOnly';
  include?: readonly ('workspace' | 'git')[];
};

export type CodeModeRuntimeConfig = {
  model: CodeModeModelConfig;
  powers: CodeModePowerConfig;
  tools?: CodeModeToolConfig;
  transcript?: {
    persist?: boolean;
    petName?: string | string[];
  };
};

export type CodeModeRuntime = {
  agent: Agent;
  model: Model<string>;
  getApiKey: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  globals: LalCodeModeGlobal[];
  execute: LalCodeModeExecute;
  systemPrompt: string;
  tool: ToolRecord;
  config: CodeModeRuntimeConfig;
  describe: () => object;
};

export declare const filesystemCapabilityType: string;
export declare const gitReadOnlyCodeModeCapabilityType: string;
export declare const gitWritableCodeModeCapabilityType: string;
export declare const gitRemoteCodeModeCapabilityType: string;

export declare function normalizeCodeModeRuntimeConfig(
  config?: Partial<CodeModeRuntimeConfig>,
): CodeModeRuntimeConfig;

export declare function resolveCodeModeModelConfig(
  modelConfig?: CodeModeModelConfig,
): { model: Model<string>; localOllama: boolean };

export declare function makeCodeModeApiKeyResolver(options: {
  modelConfig: CodeModeModelConfig;
  powers?: unknown;
  env?: Record<string, string | undefined>;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  localOllama?: boolean;
}): (provider: string) => Promise<string | undefined>;

export declare function makeCodeModeGlobals(
  config: CodeModeRuntimeConfig,
): LalCodeModeGlobal[];

export declare function makeCodeModeCompartmentExecute(options: {
  endowments: Record<string, unknown>;
  storeResult?: (
    value: unknown,
    resultName: string | string[],
  ) => Promise<void> | void;
}): LalCodeModeExecute;

export declare function makeCodeModeRuntime(options: {
  config?: Partial<CodeModeRuntimeConfig>;
  powers?: unknown;
  endowments?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  model?: Model<string>;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  execute?: LalCodeModeExecute;
  storeResult?: (
    value: unknown,
    resultName: string | string[],
  ) => Promise<void> | void;
  globals?: LalCodeModeGlobal[];
  systemPrompt?: string;
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}): CodeModeRuntime;

export declare function makeCodeModeAgent(
  options: Parameters<typeof makeCodeModeRuntime>[0],
): Agent;
