import type { Model } from '@earendil-works/pi-ai';
import type { ToolRecord } from '@endo/agent-tools';
import type {
  CodeModeRuntime,
  CodeModeRuntimeConfig,
} from './code-mode-runtime.js';

export declare function makeCodeModeDelegateTool(options: {
  callerConfig: Partial<CodeModeRuntimeConfig>;
  callerPowers?: unknown;
  endowments?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  model?: Model<string>;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  runAgent?: (runtime: CodeModeRuntime, prompt: string) => Promise<unknown>;
}): ToolRecord;
