import type { Agent } from '@earendil-works/pi-agent-core';

export type ToolCallStart = {
  type: 'ToolCallStart';
  toolName: string;
  args: unknown;
};

export type ToolCallEnd =
  | {
      type: 'ToolCallEnd';
      toolName: string;
      result: unknown;
      error?: never;
    }
  | {
      type: 'ToolCallEnd';
      toolName: string;
      error: Error;
      result?: never;
    };

export type AgentMessage = {
  type: 'Message';
  role: string;
  content: string;
};

export type AgentThinking = {
  type: 'Thinking';
  role: 'thinking' | 'thinking_delta';
  content: string;
  redacted?: boolean;
};

export type UserMessage = {
  type: 'UserMessage';
  content: string;
};

export type AgentError = {
  type: 'Error';
  message: string;
  cause: Error;
};

export type ChatEvent =
  | AgentError
  | AgentMessage
  | AgentThinking
  | UserMessage
  | ToolCallStart
  | ToolCallEnd;

export declare function runAgentRound(
  piAgent: Agent,
  prompt: string,
): AsyncGenerator<ChatEvent>;
