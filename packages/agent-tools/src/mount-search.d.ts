import type { ERef } from '@endo/eventual-send';
import type { MountSearchToolCapability, ToolRecord } from './types.js';

export declare const makeMountGlobTool: (
  mount: ERef<MountSearchToolCapability>,
) => ToolRecord;

export declare const makeMountGrepTool: (
  mount: ERef<MountSearchToolCapability>,
) => ToolRecord;

export declare const makeMountSearchTools: (
  mount: ERef<MountSearchToolCapability>,
) => ToolRecord[];
