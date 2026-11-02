export interface PackageSource {
  kind: 'npm' | 'git' | 'file';
  /** The source without its version, naming the install. */
  id: string;
  /** The canonical source, version included. */
  text: string;
  /** Whether `endo update` leaves the install alone. */
  pinned: boolean;
  /** The npm package specifier to pack. */
  specifier?: string;
  /** The git URL to clone. */
  url?: string;
  /** The git branch or tag to clone. */
  reference?: string;
  /** The local directory to read. */
  directory?: string;
}

export interface PackageManifest {
  name: string;
  version: string | undefined;
  /** Package-relative resource directories by kind. */
  directories: Record<string, string[]>;
}

export interface PackageRecord {
  id: string;
  /** The canonical source `endo update` fetches again. */
  source: string;
  pinned: boolean;
  enabled: boolean;
  name: string;
  version: string | undefined;
  /** Installed names by kind. */
  resources: Record<string, string[]>;
  /** Declared directories by kind that this installer has no destination for. */
  pending: Record<string, string[]>;
}

export type RunCommand = (
  command: string,
  commandArguments: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string }>;
