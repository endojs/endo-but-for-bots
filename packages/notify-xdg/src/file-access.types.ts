import type { ERef } from '@endo/eventual-send';
import type { FileChooserOpenOptions } from './types.js';

export type Filesystem = {
  root(): Promise<Directory>;
  named(name: string): Promise<Directory>;
};

export type Stat = {
  size: bigint;
  mtime: bigint;
  atime: bigint;
};

export type DirEntry = {
  name: string;
  kind: 'file' | 'directory';
};

export type Cursor = {
  toArray(): Promise<DirEntry[]>;
};

export type Directory = {
  lookup(name: string): Promise<Directory | File>;
  list(): Promise<Cursor>;
};

export type File = {
  open(opts?: Record<string, unknown>): Promise<object>;
  getStat(): Promise<Stat>;
};

export type FileAccessChooseFilesOptions = Omit<
  FileChooserOpenOptions,
  'directory'
>;

export type FileAccessChooseDirectoriesOptions = Omit<
  FileChooserOpenOptions,
  'directory'
>;

export type FileAccessChooser = {
  chooseFiles(
    parentWindow: string,
    title: string,
    options?: FileAccessChooseFilesOptions,
  ): Promise<ERef<File>[]>;
  chooseDirectories(
    parentWindow: string,
    title: string,
    options?: FileAccessChooseDirectoriesOptions,
  ): Promise<ERef<Directory>[]>;
  close(): Promise<void>;
};
