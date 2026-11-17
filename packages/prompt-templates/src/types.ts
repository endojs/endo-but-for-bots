// Public types for the @endo/prompt-templates package.

/** A prompt template parsed from one markdown file. */
export interface PromptTemplate {
  /** The file name without `.md`; the user invokes it as `/<name>`. */
  name: string;
  /** Frontmatter `description`, else the body's first non-empty line. */
  description: string;
  /** The text expanded into the editor, without frontmatter. */
  body: string;
  /** Frontmatter `argument-hint` tokens; the *n*th token labels `$n`. */
  argumentHint: readonly ArgumentHintToken[];
  /** The highest `$n` or `${n:-...}` position in the body, else 0. */
  maxPosition: number;
  /** Whether the body has `$@`, `$ARGUMENTS`, or a rest-slice form. */
  usesRest: boolean;
  /** The label of the source the template was loaded from. */
  source: string;
}

/** One directory of template files, reachable however the host allows. */
export interface PromptTemplateSource {
  /** Identifies the source in templates and diagnostics. */
  label: string;
  /** Lists the entry names directly under the source. */
  list(): Promise<readonly string[]>;
  /** Reads one entry's full text. */
  readText(entryName: string): Promise<string>;
}

/** A file or source that could not be loaded, and why. */
export interface PromptTemplateDiagnostic {
  source: string;
  entryName?: string;
  message: string;
}

export interface LoadPromptTemplatesResult {
  /** Sorted by name, with one template per name. */
  templates: readonly PromptTemplate[];
  diagnostics: readonly PromptTemplateDiagnostic[];
}

/** One token of an `argument-hint` such as `<focus> [scope]`. */
export interface ArgumentHintToken {
  /** The token text without its brackets. */
  label: string;
  /** True for `<angle>` tokens, false for `[square]` or bare tokens. */
  required: boolean;
}

/** What a template body's placeholders require of its arguments. */
export interface PlaceholderAnalysis {
  maxPosition: number;
  usesRest: boolean;
}
