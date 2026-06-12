import type {
  CodeModeRuntime,
  CodeModeRuntimeConfig,
  makeCodeModeRuntime,
} from './code-mode-runtime.js';

export type CodeModeService = {
  prompt: (text: string) => Promise<object>;
  status: () => object;
  help: (methodName?: string) => string;
};

export declare function loadCodeModeConfig(options?: {
  config?: Partial<CodeModeRuntimeConfig>;
  env?: Record<string, string | undefined>;
}): CodeModeRuntimeConfig;

export declare function makeCodeModeService(options: {
  runtime: CodeModeRuntime;
  context?: unknown;
}): CodeModeService;

export declare function make(
  powers: unknown,
  context: unknown,
  options?: Omit<
    Parameters<typeof makeCodeModeRuntime>[0],
    'config' | 'powers'
  > & {
    config?: Partial<CodeModeRuntimeConfig>;
    env?: Record<string, string | undefined>;
  },
): Promise<CodeModeService>;
