import type {
  CodeModeRuntime,
  makeCodeModeRuntime,
} from './code-mode-runtime.js';

export type PiExtensionApiLike = {
  registerTool: (tool: object) => unknown;
  registerCommand?: (name: string, command: object) => unknown;
  on?: (
    eventName: string,
    handler: (event: unknown, ctx?: unknown) => unknown,
  ) => unknown;
};

export declare function registerEndoCodeModeExtension(
  pi: PiExtensionApiLike,
  options: Parameters<typeof makeCodeModeRuntime>[0] & {
    runtime?: CodeModeRuntime;
  },
): CodeModeRuntime;

export declare function makeEndoCodeModeExtension(
  options: Parameters<typeof makeCodeModeRuntime>[0] & {
    runtime?: CodeModeRuntime;
  },
): (pi: PiExtensionApiLike) => CodeModeRuntime;

declare function endoCodeModeExtension(
  pi: PiExtensionApiLike,
  options?: Parameters<typeof makeCodeModeRuntime>[0] & {
    runtime?: CodeModeRuntime;
  },
): CodeModeRuntime;

export default endoCodeModeExtension;
