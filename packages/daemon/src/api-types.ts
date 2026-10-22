import type { Config, EndoBootstrap } from './types.js';

export declare function start(config?: Config): Promise<void>;
export declare function stop(config?: Config): Promise<void>;
export declare function restart(config?: Config): Promise<void>;
export declare function terminate(config?: Config): Promise<void>;
export declare function clean(config?: Config): Promise<void>;
export declare function purge(config?: Config): Promise<void>;
export declare function makeEndoClient<TBootstrap>(
  name: string,
  sockPath: string,
  cancelled: Promise<void>,
  bootstrap?: TBootstrap,
): Promise<{
  getBootstrap: () => Promise<EndoBootstrap>;
  closed: Promise<void>;
}>;
