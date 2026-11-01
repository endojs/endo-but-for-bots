export type ShellSlotType = 'string' | 'relative-path';

export type ShellOptionMember =
  string | { prefix: string; type: ShellSlotType; name?: string };

export type ShellCommandElement =
  | { kind: 'literal'; value: string }
  | {
      kind: 'slot';
      name: string;
      type: ShellSlotType;
      prefix?: string;
      optional?: boolean;
      description?: string;
    }
  | {
      kind: 'options';
      options: readonly ShellOptionMember[];
      optional?: boolean;
      repeat?: boolean;
      name?: string;
      description?: string;
    }
  | {
      kind: 'group';
      elements: readonly ShellCommandElement[];
      optional?: boolean;
      repeat?: boolean;
      description?: string;
    }
  | { kind: 'rest'; name: string; type: ShellSlotType; description?: string };

/**
 * A passable (copyable pass-style data) description of one accepted command
 * form: a fixed program name and a grammar over its argument tokens.  Matched
 * argument vectors are the only ones `exec` will spawn; the grammar
 * constrains the argument language, not just argv[0].
 */
export type ShellCommandGrammar = {
  program: string;
  argumentVector: readonly ShellCommandElement[];
  description?: string;
};

export type ShellPolicy = {
  commands: readonly ShellCommandGrammar[];
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  searchPath?: string;
};

export type ShellInspectResult = {
  commands: readonly ShellCommandGrammar[];
  usage: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
};

/**
 * The engine `makeShell` drives execution through: host or sandbox, chosen by
 * the caller.  Declared structurally here so this shipped public surface does
 * not depend on a runtime dependency on `@endo/host-spawner`; that package's
 * `Spawner` is assignable to this shape.
 */
export type Spawner = (
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string>; shell?: boolean },
) => Promise<{
  pid: number;
  stdout?: AsyncIterable<Uint8Array> | null;
  stderr?: AsyncIterable<Uint8Array> | null;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: string | number) => Promise<void>;
}>;

export type EndoShell = {
  inspect: () => Promise<ShellInspectResult>;
  exec: (
    command: string,
    argumentVector: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ShellResult>;
  attenuate: (
    commands: readonly ShellCommandGrammar[],
    options?: { timeoutMs?: number },
  ) => Promise<EndoShell>;
};
