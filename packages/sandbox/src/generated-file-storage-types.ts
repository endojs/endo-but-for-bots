import type {
  GeneratedFilePath,
  ValidatedGeneratedFile,
} from './generated-file-types.js';

export type GeneratedFileMount = Readonly<{
  hostPath: string;
  innerPath: GeneratedFilePath;
  mode: 'ro';
}>;

export type GeneratedFileStage = Readonly<{
  prepare(): Promise<readonly GeneratedFileMount[]>;
  /** Call only after every container using these files has been removed. */
  release(): Promise<void>;
}>;

/** Host-only allocator shared across slices, never a guest configuration option. */
export type GeneratedFileStorage = Readonly<{
  makeStage(
    files: readonly ValidatedGeneratedFile[],
    writableHostPaths: readonly string[],
  ): GeneratedFileStage;
  /** Fence allocation; reject while a stage is still in use. Retry after release. */
  close(): Promise<void>;
}>;
