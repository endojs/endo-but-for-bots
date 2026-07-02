export type * from './src/types.d.ts';

// Runtime exports of `index.js` re-declared for TypeScript consumers
// that resolve `@endo/gateway` through the `types` field. The
// implementations live in `index.js`; this file restates the shapes
// so consumers reading the published package's `.d.ts` see them as
// well.

import type {
  GatewayConfig,
  GatewayPathInfo,
  GatewayPathResolution,
  GatewayPowers,
  Gateway,
} from './src/types.d.ts';

export declare const detectServiceMode: (args?: {
  uid?: number;
  env?: { [name: string]: string | undefined };
  explicit?: boolean;
}) => 'system' | 'user';

export declare const resolveGatewayPaths: (args: {
  mode: 'system' | 'user';
  platform: string;
  env?: { [name: string]: string | undefined };
  info: GatewayPathInfo;
}) => {
  stateDir: GatewayPathResolution;
  runtimeDir: GatewayPathResolution;
  logDir: GatewayPathResolution;
  cacheDir: GatewayPathResolution;
  configFile: GatewayPathResolution;
};

export declare const makeGateway: (args?: {
  powers?: GatewayPowers;
  config?: Partial<GatewayConfig>;
}) => Gateway;

export declare const SYSTEM_STATE_DIR_LINUX: string;
export declare const SYSTEM_RUNTIME_DIR_LINUX: string;
export declare const SYSTEM_LOG_DIR_LINUX: string;
export declare const SYSTEM_CACHE_DIR_LINUX: string;
export declare const SYSTEM_CONFIG_FILE_LINUX: string;
export declare const SYSTEM_STATE_DIR_DARWIN: string;
export declare const SYSTEM_RUNTIME_DIR_DARWIN: string;
export declare const SYSTEM_LOG_DIR_DARWIN: string;
export declare const SYSTEM_CACHE_DIR_DARWIN: string;
export declare const SYSTEM_CONFIG_FILE_DARWIN: string;
export declare const USER_DIR_SUBDIR: string;
