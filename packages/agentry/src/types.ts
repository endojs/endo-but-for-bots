import type { Message, Model } from '@earendil-works/pi-ai';
import type {
  Agent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@earendil-works/pi-agent-core';

import type { Credentials, GetApiKey, ThinkingLevel } from './harness/types.js';

/** The powerless first stage of an agent definition. */
export interface AgentDefinition {
  model: Model<string>;
  localOllama: boolean;
  instructions: string;
  toolSchemas: AgentTool<any>[];
}

/** The powered inputs accepted by an agent maker. */
export interface AgentMakeOptions {
  powers?: unknown;
  credentials?: Credentials;
  tools?: AgentTool<any>[];
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: GetApiKey;
  thinkingLevel?: ThinkingLevel;
}

/** The powered second-stage agent maker. */
export type AgentMaker = (options?: AgentMakeOptions) => Agent;

/** Configuration for defining an agent without holding powers. */
export interface AgentConfig {
  model?:
    | Model<string>
    | string
    | {
        provider?: string;
        model?: string;
        baseUrl?: string;
        reasoning?: boolean;
      };
  instructions?: string;
  tools?: AgentTool<any>[];
  endow?: (
    definition: AgentDefinition,
    options: AgentMakeOptions,
  ) => {
    tools?: AgentTool<any>[];
    getApiKey?: GetApiKey;
  };
}
