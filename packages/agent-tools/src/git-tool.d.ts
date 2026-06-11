import type { ERef } from '@endo/far';
import type { GitToolCapability, ToolPowers, ToolRecord } from './types.js';

export declare const makeGitTool: (
  gitCap: ERef<GitToolCapability>,
  powers?: ERef<ToolPowers>,
) => ToolRecord[];
