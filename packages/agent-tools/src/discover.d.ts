import type { ERef } from '@endo/eventual-send';
import type { CapabilityToolOptions, ToolRecord } from './types.js';

export declare const discoverCapabilityTools: (
  powers: ERef<any>,
  options?: CapabilityToolOptions,
) => Promise<ToolRecord[]>;
