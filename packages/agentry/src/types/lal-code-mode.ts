import type {
  Agent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Message, Model, Tool } from '@earendil-works/pi-ai';
import type { ToolRecord } from '@endo/agent-tools';

export type LalCodeModeGlobal = {
  name: string;
  petName?: string | string[];
  type?: string;
  description?: string;
};

export type LalCodeModeExecuteInput = {
  source: string;
  resultName?: string | string[];
  globals: LalCodeModeGlobal[];
};

export type LalCodeModeExecute = (
  input: LalCodeModeExecuteInput,
) => Promise<unknown>;

export declare function normalizeLalCodeModeGlobals(
  globals: LalCodeModeGlobal[],
): LalCodeModeGlobal[];

export declare function makeLalCodeModeSystemPrompt(
  globals: LalCodeModeGlobal[],
  options?: { preamble?: string },
): string;

export declare function makeLalCodeModeExecuteTool(
  execute: LalCodeModeExecute,
  globals: LalCodeModeGlobal[],
): ToolRecord;

export declare function toPiAgentTool(
  tool: ToolRecord,
): AgentTool<Tool['parameters']>;

export declare function makeLalCodeModeAgent(options: {
  model: Model<string>;
  globals: LalCodeModeGlobal[];
  execute: LalCodeModeExecute;
  systemPrompt?: string;
  messages?: AgentMessage[];
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}): Agent;
