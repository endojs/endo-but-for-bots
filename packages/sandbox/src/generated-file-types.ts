/** Literal configuration bytes; the runtime always mounts the result read-only. */
export type GeneratedFile = Readonly<{
  innerPath: string;
  contents: string;
}>;

/** A canonical absolute destination checked at the configuration boundary. */
export type GeneratedFilePath = string & {
  readonly __generatedFilePath: unique symbol;
};

export type ValidatedGeneratedFile = Readonly<{
  innerPath: GeneratedFilePath;
  contents: string;
}>;
