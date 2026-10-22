export declare function whereEndoState(
  platform: string,
  env: { [name: string]: string | undefined },
  info: { home: string },
): string;
export declare function whereEndoEphemeralState(
  platform: string,
  env: { [name: string]: string | undefined },
  info: { home: string; user: string; temp: string },
): string;
export declare function whereEndoSock(
  platform: string,
  env: { [name: string]: string | undefined },
  info: { home: string; user: string; temp: string },
  protocol?: string,
): string;
export declare function whereEndoCache(
  platform: string,
  env: { [name: string]: string | undefined },
  info: { home: string },
): string;
